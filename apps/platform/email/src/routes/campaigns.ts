import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { DomainRepository } from '../repositories/domain-repository.js';
import { DomainResolver } from '../services/domain-resolver.js';
import { EmailCampaignJobsRepository } from '../repositories/email-campaign-jobs-repository.js';
import { EmailCampaignRecipientsRepository } from '../repositories/email-campaign-recipients-repository.js';
import { SpamCheckerService } from '../services/spam-checker.js';
import {
  TemplateServiceClient,
  TemplateRenderError,
  TemplateServiceUnavailableError,
} from '../clients/template-service-client.js';
import { DomainNotConfiguredError, DomainNotVerifiedError } from '../errors.js';
import { env } from '../env.js';

const CampaignSendBodySchema = Type.Object({
  job_ref: Type.String(),
  location_id: Type.String(),
  entity_type: Type.Optional(Type.String()),
  entity_id: Type.Optional(Type.String()),
  template_id: Type.String(),
  subject_template: Type.String(),
  recipients: Type.Array(
    Type.Object({
      email: Type.String(),
      context: Type.Record(Type.String(), Type.Unknown()),
    }),
  ),
  scheduled_for: Type.Optional(Type.String()),
});

export async function campaignRoutes(app: FastifyInstance): Promise<void> {
  const jobsRepo = new EmailCampaignJobsRepository(app.db);
  const recipientsRepo = new EmailCampaignRecipientsRepository(app.db);
  const domainResolver = new DomainResolver(new DomainRepository(app.db));
  const templateClient = new TemplateServiceClient(env.TEMPLATE_SERVICE_URL);

  // POST /emails/campaigns/send
  app.post('/campaigns/send', {
    schema: { body: CampaignSendBodySchema },
  }, async (request, reply) => {
    const body = request.body as {
      job_ref: string;
      location_id: string;
      entity_type?: string;
      entity_id?: string;
      template_id: string;
      subject_template: string;
      recipients: Array<{ email: string; context: Record<string, unknown> }>;
      scheduled_for?: string;
    };

    // Step 1 — Domain check
    let domain;
    try {
      domain = await domainResolver.resolve(body.location_id);
    } catch (err) {
      if (err instanceof DomainNotConfiguredError) {
        return reply.status(422).send({ error: 'domain_not_configured' });
      }
      if (err instanceof DomainNotVerifiedError) {
        return reply.status(422).send({ error: 'domain_not_verified' });
      }
      throw err;
    }

    // Step 2 — Dedup
    const existing = await jobsRepo.findByJobRef(body.job_ref);
    if (existing) {
      return reply.status(200).send({
        job_id: existing.id,
        status: existing.status,
        total_recipients: existing.total_recipients,
      });
    }

    // Step 3 — Recipient limit (redundant due to maxItems but explicit check per spec)
    if (body.recipients.length > 10000) {
      return reply.status(422).send({
        error: 'recipient_limit_exceeded',
        limit: 10000,
        provided: body.recipients.length,
      });
    }

    // Step 4 — Create job
    const job = await jobsRepo.create({
      job_ref: body.job_ref,
      location_id: body.location_id,
      entity_type: body.entity_type ?? null,
      entity_id: body.entity_id ?? null,
      template_id: body.template_id,
      subject_template: body.subject_template,
      domain_id: domain.id,
      scheduled_for: body.scheduled_for ?? null,
      created_by: (request as { user?: { sub?: string } }).user?.sub ?? null,
    });

    // Step 5 — Sample render
    let rendered: { html: string; text?: string };
    try {
      rendered = await templateClient.render(
        body.template_id,
        body.recipients[0]?.context ?? {},
      );
    } catch (err) {
      if (err instanceof TemplateRenderError) {
        await jobsRepo.setFailed(job.id, 'template_render_failed');
        return reply.status(422).send({ error: 'template_render_failed', job_id: job.id });
      }
      if (err instanceof TemplateServiceUnavailableError) {
        await jobsRepo.setFailed(job.id, 'template_service_unavailable');
        return reply.status(503).send({ error: 'template_service_unavailable', job_id: job.id });
      }
      throw err;
    }

    // Step 6 — Spam check
    const spamChecker = new SpamCheckerService(
      new DomainRepository(app.db),
      env.SPAM_SCORE_THRESHOLD_DEFAULT ?? 5.0,
    );

    // Resolve subject for spam check (replace {{varName}} placeholders with first recipient context)
    const firstContext = body.recipients[0]?.context ?? {};
    const resolvedSubject = body.subject_template.replace(
      /\{\{(\w+)\}\}/g,
      (_, key: string) => String(firstContext[key] ?? ''),
    );

    const spamResult = await spamChecker.check({
      locationId: body.location_id,
      subject: resolvedSubject,
      html: rendered.html,
      text: rendered.text ?? '',
    });

    if (!spamResult.passed) {
      await jobsRepo.setSpamCheckFailed(job.id, spamResult.score, spamResult.issues);
      return reply.status(422).send({
        error: 'spam_check_failed',
        job_id: job.id,
        score: spamResult.score,
        threshold: spamResult.threshold,
        issues: spamResult.issues,
      });
    }
    await jobsRepo.updateSpamScore(job.id, spamResult.score, spamResult.issues);

    // Step 7 — Bulk insert recipients
    await recipientsRepo.bulkInsert(
      body.recipients.map((r) => ({
        job_id: job.id,
        to_email: r.email,
        context: r.context,
      })),
    );

    // Step 8 — Set processing
    await jobsRepo.setProcessing(job.id, body.recipients.length);

    // Step 9 — Enqueue
    const scheduledDelay =
      body.scheduled_for && Date.parse(body.scheduled_for) > Date.now()
        ? Date.parse(body.scheduled_for) - Date.now()
        : 0;

    const pendingRecipients = await recipientsRepo.findPendingByJobId(job.id);
    for (const recipient of pendingRecipients) {
      await app.queues.campaignRecipient.add(
        'send',
        { recipientId: recipient.id },
        { delay: scheduledDelay },
      );
    }

    return reply.status(202).send({
      job_id: job.id,
      status: 'processing',
      total_recipients: body.recipients.length,
    });
  });

  // GET /emails/campaigns/:jobId
  app.get('/campaigns/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const found = await jobsRepo.findById(jobId);
    if (!found) {
      return reply.status(404).send({ error: 'not_found' });
    }
    return reply.status(200).send({
      job_id: found.id,
      status: found.status,
      total_recipients: found.total_recipients,
      sent_count: found.sent_count,
      failed_count: found.failed_count,
    });
  });

  // GET /emails/campaigns/:jobId/recipients
  app.get('/campaigns/:jobId/recipients', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const query = request.query as { status?: string; page?: string };

    const jobFound = await jobsRepo.findById(jobId);
    if (!jobFound) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const page = query.page ? parseInt(query.page, 10) : 1;
    const { recipients, total } = await recipientsRepo.findByJobIdPaginated(jobId, {
      status: query.status,
      page,
      pageSize: 100,
    });

    return reply.status(200).send({
      recipients,
      total,
      page,
      page_size: 100,
    });
  });

  // DELETE /emails/campaigns/:jobId
  app.delete('/campaigns/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const found = await jobsRepo.findById(jobId);
    if (!found) {
      return reply.status(404).send({ error: 'not_found' });
    }
    if (!['pending', 'spam_check_failed'].includes(found.status)) {
      return reply.status(409).send({ error: 'cannot_cancel', status: found.status });
    }
    await jobsRepo.cancel(jobId);
    return reply.status(200).send({ job_id: jobId, status: 'cancelled' });
  });
}
