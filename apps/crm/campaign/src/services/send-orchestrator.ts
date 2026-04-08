import type { Knex } from 'knex';
import type { Campaign } from '../repositories/campaigns.repo.js';
import type { LeadContact } from './audience-resolver.js';
import * as sendsRepo from '../repositories/campaign-sends.repo.js';
import * as recipientsRepo from '../repositories/campaign-recipients.repo.js';

interface Env {
  EMAIL_SERVICE_URL: string;
}

export async function orchestrateNonAB(
  db: Knex,
  campaign: Campaign,
  groupedByLocation: Map<string, LeadContact[]>,
  env: Env,
): Promise<void> {
  for (const [locationId, leads] of groupedByLocation) {
    const jobRef = `${campaign.id}:${locationId}`;

    // Crash recovery guard — skip if already sent for this location
    const existing = await sendsRepo.findByEmailJobRef(db, jobRef);
    if (existing) continue;

    // Call Email Service
    const res = await fetch(`${env.EMAIL_SERVICE_URL}/emails/campaigns/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_ref: jobRef,
        location_id: locationId,
        template_id: campaign.template_id,
        subject_template: campaign.subject,
        recipients: leads.map((l) => ({
          id: l.id,
          email: l.email,
          first_name: l.first_name,
        })),
        entity_type: 'campaign',
        entity_id: campaign.id,
      }),
    });

    if (res.status === 422) {
      // Spam check failed or domain not configured — mark as failed, continue
      await sendsRepo.insert(db, {
        campaign_id: campaign.id,
        location_id: locationId,
        variant: null,
        subject_used: campaign.subject ?? '',
        email_job_id: null,
        email_job_ref: jobRef,
        status: 'failed',
        total_recipients: leads.length,
        sent_count: 0,
        failed_count: 0,
        started_at: null,
        completed_at: new Date(),
      });
      continue;
    }

    if (!res.ok) {
      throw new Error(`Email Service returned ${res.status}: ${await res.text()}`);
    }

    // 202 Accepted — record send and recipients in a single transaction
    const body = (await res.json()) as { job_id: string };

    await db.transaction(async (trx) => {
      await sendsRepo.insert(trx, {
        campaign_id: campaign.id,
        location_id: locationId,
        variant: null,
        subject_used: campaign.subject ?? '',
        email_job_id: body.job_id,
        email_job_ref: jobRef,
        status: 'sending',
        total_recipients: leads.length,
        sent_count: 0,
        failed_count: 0,
        started_at: new Date(),
        completed_at: null,
      });

      const recipientRows = leads.map((l) => ({
        campaign_id: campaign.id,
        lead_id: l.id,
        email: l.email,
        location_id: locationId,
        variant: null,
      }));

      await recipientsRepo.bulkInsert(trx, recipientRows);
    });
  }
}
