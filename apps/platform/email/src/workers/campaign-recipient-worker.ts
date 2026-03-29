import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Knex } from '../db.js';
import type { EventBus } from '@ortho/event-bus';
import { EmailCampaignJobsRepository } from '../repositories/email-campaign-jobs-repository.js';
import { EmailCampaignRecipientsRepository } from '../repositories/email-campaign-recipients-repository.js';
import { DomainRepository } from '../repositories/domain-repository.js';
import { TemplateServiceClient, TemplateRenderError, TemplateServiceUnavailableError } from '../clients/template-service-client.js';
import { env } from '../env.js';

interface CampaignRecipientJobData {
  recipientId: string;
}

function resolveSubject(subjectTemplate: string, context: Record<string, unknown>): string {
  return subjectTemplate.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const val = context[key];
    return val !== undefined && val !== null ? String(val) : '';
  });
}

export function createCampaignRecipientWorker(
  connection: Redis,
  db: Knex,
  eventBus: EventBus,
): Worker {
  const recipientsRepo = new EmailCampaignRecipientsRepository(db);
  const jobsRepo = new EmailCampaignJobsRepository(db);
  const domainRepo = new DomainRepository(db);
  const templateClient = new TemplateServiceClient(env.TEMPLATE_SERVICE_URL);

  async function checkCompletion(jobId: string): Promise<void> {
    const counts = await jobsRepo.findById(jobId);
    if (!counts) return;

    let terminalStatus: string;
    if (counts.failed_count === counts.total_recipients) {
      terminalStatus = 'failed';
    } else if (
      counts.sent_count + counts.failed_count === counts.total_recipients &&
      counts.failed_count > 0
    ) {
      terminalStatus = 'completed_with_errors';
    } else {
      terminalStatus = 'completed';
    }

    const won = await jobsRepo.attemptCompletion(jobId, terminalStatus);
    if (won) {
      // Re-fetch to get the final counts for the event payload
      const finalJob = await jobsRepo.findById(jobId);
      if (!finalJob) return;
      await eventBus.publish({
        event_type: 'email.campaign_completed',
        entity_type: finalJob.entity_type ?? undefined,
        entity_id: finalJob.entity_id ?? undefined,
        payload: {
          job_id: finalJob.id,
          job_ref: finalJob.job_ref,
          status: terminalStatus,
          total_recipients: finalJob.total_recipients,
          sent_count: finalJob.sent_count,
          failed_count: finalJob.failed_count,
          location_id: finalJob.location_id,
        },
      });
    }
  }

  const worker = new Worker<CampaignRecipientJobData>(
    'campaign-recipient',
    async (job) => {
      // Step 1: Fetch recipient; crash recovery guard
      const recipient = await recipientsRepo.findById(job.data.recipientId);
      if (!recipient || recipient.status !== 'pending') return;

      // Step 2: Increment attempt
      await recipientsRepo.incrementAttempt(recipient.id);

      // Step 3: Fetch campaign job
      const campaignJob = await jobsRepo.findById(recipient.job_id);
      if (!campaignJob) return;

      // Step 4: Fetch domain
      const domain = await domainRepo.findById(campaignJob.domain_id);

      // Step 5: Render template
      let rendered: { html: string; text?: string };
      try {
        rendered = await templateClient.render(campaignJob.template_id, recipient.context as Record<string, unknown>);
      } catch (err) {
        if (err instanceof TemplateRenderError) {
          await recipientsRepo.markFailed(recipient.id, err.message);
          await jobsRepo.incrementFailedCount(campaignJob.id);
          await checkCompletion(campaignJob.id);
          return;
        }
        if (err instanceof TemplateServiceUnavailableError) {
          throw err; // BullMQ retry
        }
        throw err;
      }

      // Step 6: Resolve subject
      const resolvedSubject = resolveSubject(
        campaignJob.subject_template,
        recipient.context as Record<string, unknown>,
      );

      // Step 7: Send via SendGrid
      const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: recipient.to_email }] }],
          from: { email: domain?.from_email, name: domain?.from_name },
          subject: resolvedSubject,
          content: [
            { type: 'text/html', value: rendered.html },
            ...(rendered.text ? [{ type: 'text/plain', value: rendered.text }] : []),
          ],
        }),
      });

      // Step 8: 202 success
      if (response.status === 202) {
        const sendgridMessageId = response.headers.get('X-Message-Id') ?? '';
        await recipientsRepo.markSent(recipient.id, sendgridMessageId);
        await jobsRepo.incrementSentCount(campaignJob.id);
        await checkCompletion(campaignJob.id);
        return;
      }

      // Step 9: 400 = suppressed address (bounce)
      if (response.status === 400) {
        await recipientsRepo.markBounced(recipient.id);
        await eventBus.publish({
          event_type: 'email.bounced',
          entity_type: campaignJob.entity_type ?? undefined,
          entity_id: campaignJob.entity_id ?? undefined,
          payload: {
            to_address: recipient.to_email,
            job_id: campaignJob.id,
            recipient_id: recipient.id,
          },
        });
        await jobsRepo.incrementFailedCount(campaignJob.id);
        await checkCompletion(campaignJob.id);
        return;
      }

      // Step 10: Other non-202 → throw to trigger BullMQ retry
      throw new Error(`SendGrid responded with ${response.status}`);
    },
    {
      connection,
      concurrency: 10,
    },
  );

  return worker;
}
