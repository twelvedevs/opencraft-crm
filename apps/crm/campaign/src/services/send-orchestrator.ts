import type { Knex } from 'knex';
import type { Campaign } from '../repositories/campaigns.repo.js';
import type { LeadContact } from './audience-resolver.js';
import type { CampaignRecipient } from '../repositories/campaign-recipients.repo.js';
import * as sendsRepo from '../repositories/campaign-sends.repo.js';
import * as recipientsRepo from '../repositories/campaign-recipients.repo.js';

interface Env {
  EMAIL_SERVICE_URL: string;
}

async function sendVariant(
  env: Env,
  campaign: Campaign,
  locationId: string,
  jobRef: string,
  leads: LeadContact[],
  subjectTemplate: string,
): Promise<Response> {
  return fetch(`${env.EMAIL_SERVICE_URL}/emails/campaigns/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job_ref: jobRef,
      location_id: locationId,
      template_id: campaign.template_id,
      subject_template: subjectTemplate,
      recipients: leads.map((l) => ({
        id: l.id,
        email: l.email,
        first_name: l.first_name,
      })),
      entity_type: 'campaign',
      entity_id: campaign.id,
    }),
  });
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

export async function orchestrateAB(
  db: Knex,
  campaign: Campaign,
  groupedByLocation: Map<string, LeadContact[]>,
  env: Env,
): Promise<void> {
  for (const [locationId, leads] of groupedByLocation) {
    const n = leads.length;

    let groupA: LeadContact[];
    let groupB: LeadContact[];
    let holdout: LeadContact[] = [];

    if (campaign.ab_mode === 'holdout') {
      const splitSize = Math.floor(n * (campaign.ab_test_split_pct ?? 0) / 100);
      groupA = leads.slice(0, splitSize);
      groupB = leads.slice(splitSize, splitSize * 2);
      holdout = leads.slice(splitSize * 2);
    } else {
      // full_split: 50/50
      const splitSize = Math.floor(n / 2);
      groupA = leads.slice(0, splitSize);
      groupB = leads.slice(splitSize);
    }

    const jobRefA = `${campaign.id}:${locationId}:A`;
    const jobRefB = `${campaign.id}:${locationId}:B`;

    // Crash recovery: skip location+variant combos that already have campaign_sends
    const existingA = await sendsRepo.findByEmailJobRef(db, jobRefA);
    const existingB = await sendsRepo.findByEmailJobRef(db, jobRefB);

    if (existingA && existingB) continue;

    const now = new Date();
    let jobIdA: string | null = null;
    let jobIdB: string | null = null;

    // Send variant A
    if (!existingA && groupA.length > 0) {
      const res = await sendVariant(
        env, campaign, locationId, jobRefA, groupA,
        campaign.ab_variant_a_subject ?? campaign.subject ?? '',
      );

      if (res.status === 422) {
        await sendsRepo.insert(db, {
          campaign_id: campaign.id,
          location_id: locationId,
          variant: 'A',
          subject_used: campaign.ab_variant_a_subject ?? '',
          email_job_id: null,
          email_job_ref: jobRefA,
          status: 'failed',
          total_recipients: groupA.length,
          sent_count: 0,
          failed_count: 0,
          started_at: null,
          completed_at: now,
        });
        continue;
      }

      if (!res.ok) {
        throw new Error(`Email Service returned ${res.status}: ${await res.text()}`);
      }

      const body = (await res.json()) as { job_id: string };
      jobIdA = body.job_id;
    }

    // Send variant B
    if (!existingB && groupB.length > 0) {
      const res = await sendVariant(
        env, campaign, locationId, jobRefB, groupB,
        campaign.ab_variant_b_subject ?? campaign.subject ?? '',
      );

      if (res.status === 422) {
        await sendsRepo.insert(db, {
          campaign_id: campaign.id,
          location_id: locationId,
          variant: 'B',
          subject_used: campaign.ab_variant_b_subject ?? '',
          email_job_id: null,
          email_job_ref: jobRefB,
          status: 'failed',
          total_recipients: groupB.length,
          sent_count: 0,
          failed_count: 0,
          started_at: null,
          completed_at: now,
        });
        continue;
      }

      if (!res.ok) {
        throw new Error(`Email Service returned ${res.status}: ${await res.text()}`);
      }

      const body = (await res.json()) as { job_id: string };
      jobIdB = body.job_id;
    }

    // Insert sends and recipients in a single transaction per location
    await db.transaction(async (trx) => {
      if (!existingA) {
        await sendsRepo.insert(trx, {
          campaign_id: campaign.id,
          location_id: locationId,
          variant: 'A',
          subject_used: campaign.ab_variant_a_subject ?? '',
          email_job_id: jobIdA,
          email_job_ref: jobRefA,
          status: 'sending',
          total_recipients: groupA.length,
          sent_count: 0,
          failed_count: 0,
          started_at: now,
          completed_at: null,
        });
      }

      if (!existingB) {
        await sendsRepo.insert(trx, {
          campaign_id: campaign.id,
          location_id: locationId,
          variant: 'B',
          subject_used: campaign.ab_variant_b_subject ?? '',
          email_job_id: jobIdB,
          email_job_ref: jobRefB,
          status: 'sending',
          total_recipients: groupB.length,
          sent_count: 0,
          failed_count: 0,
          started_at: now,
          completed_at: null,
        });
      }

      const recipientRows: CampaignRecipient[] = [];

      for (const lead of groupA) {
        recipientRows.push({
          campaign_id: campaign.id,
          lead_id: lead.id,
          email: lead.email,
          location_id: locationId,
          variant: 'A',
          sent_at: now,
        });
      }

      for (const lead of groupB) {
        recipientRows.push({
          campaign_id: campaign.id,
          lead_id: lead.id,
          email: lead.email,
          location_id: locationId,
          variant: 'B',
          sent_at: now,
        });
      }

      for (const lead of holdout) {
        recipientRows.push({
          campaign_id: campaign.id,
          lead_id: lead.id,
          email: lead.email,
          location_id: locationId,
          variant: 'holdout',
          sent_at: null,
        });
      }

      if (recipientRows.length > 0) {
        await recipientsRepo.bulkInsertFull(trx, recipientRows);
      }
    });
  }
}
