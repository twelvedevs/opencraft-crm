import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  HAS_DB,
  runMigrations,
  cleanup,
  truncateTables,
  getDb,
  insertCampaign,
  USER_ID,
  LOCATION_ID,
} from './helpers.js';
import { handleLeadStageChanged } from '../../src/handlers/lead-stage-changed.handler.js';
import { handleEmailOpened } from '../../src/handlers/email-opened.handler.js';
import * as sendsRepo from '../../src/repositories/campaign-sends.repo.js';
import * as campaignsRepo from '../../src/repositories/campaigns.repo.js';
import type { Knex } from 'knex';

// ─── Constants ──────────────────────────────────────────────

const LOC_A = '00000000-0000-0000-0000-00000000000a';
const LEAD_1 = 'lead-attr-1';
const LEAD_2 = 'lead-attr-2';

// ─── Helpers ────────────────────────────────────────────────

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function daysAfter(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

async function insertRecipient(
  db: Knex,
  data: {
    campaign_id: string;
    lead_id: string;
    location_id?: string;
    variant?: string | null;
    sent_at?: Date | null;
  },
): Promise<void> {
  await db('campaign_recipients').insert({
    campaign_id: data.campaign_id,
    lead_id: data.lead_id,
    email: `${data.lead_id}@test.com`,
    location_id: data.location_id ?? LOC_A,
    variant: data.variant ?? null,
    sent_at: data.sent_at ?? null,
  });
}

// ─── Tests: Conversion Attribution ─────────────────────────

describe.skipIf(!HAS_DB)('Conversion attribution (integration)', () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
  });

  // ─── 1. Conversion within 7-day window ───────────────────

  it('records conversion when stage change is within 7-day window of sent_at', async () => {
    const db = getDb();

    const sentAt = daysAgo(3);
    const occurredAt = daysAfter(sentAt, 1); // 1 day after sent_at → within window

    const campaign = await insertCampaign(db, {
      status: 'sending',
      sent_at: sentAt,
    });
    const campaignId = campaign.id as string;

    await insertRecipient(db, {
      campaign_id: campaignId,
      lead_id: LEAD_1,
      sent_at: sentAt,
    });

    await handleLeadStageChanged(
      {
        lead_id: LEAD_1,
        stage_to: 'contract_signed',
        pipeline: 'new_patient',
        occurred_at: occurredAt.toISOString(),
      },
      db,
    );

    const conversions = await db('campaign_conversions').where({ campaign_id: campaignId });
    expect(conversions).toHaveLength(1);
    expect(conversions[0].lead_id).toBe(LEAD_1);
    expect(conversions[0].stage_to).toBe('contract_signed');
    expect(conversions[0].pipeline).toBe('new_patient');
    // converted_at should be occurred_at, not now()
    expect(new Date(conversions[0].converted_at).getTime()).toBeCloseTo(occurredAt.getTime(), -3);
  });

  // ─── 2. Conversion outside 7-day window ──────────────────

  it('does NOT record conversion when stage change is outside 7-day window', async () => {
    const db = getDb();

    const sentAt = daysAgo(10);
    const occurredAt = daysAfter(sentAt, 8); // 8 days after sent_at → outside window

    const campaign = await insertCampaign(db, {
      status: 'sending',
      sent_at: sentAt,
    });
    const campaignId = campaign.id as string;

    await insertRecipient(db, {
      campaign_id: campaignId,
      lead_id: LEAD_1,
      sent_at: sentAt,
    });

    await handleLeadStageChanged(
      {
        lead_id: LEAD_1,
        stage_to: 'contract_signed',
        pipeline: 'new_patient',
        occurred_at: occurredAt.toISOString(),
      },
      db,
    );

    const conversions = await db('campaign_conversions').where({ campaign_id: campaignId });
    expect(conversions).toHaveLength(0);
  });

  // ─── 3. Holdout lead (sent_at=NULL) → no conversion ──────

  it('does NOT record conversion for holdout lead with sent_at=NULL', async () => {
    const db = getDb();

    const campaign = await insertCampaign(db, {
      status: 'sending',
      sent_at: daysAgo(3),
    });
    const campaignId = campaign.id as string;

    // Holdout recipient — sent_at is NULL
    await insertRecipient(db, {
      campaign_id: campaignId,
      lead_id: LEAD_1,
      variant: 'holdout',
      sent_at: null,
    });

    await handleLeadStageChanged(
      {
        lead_id: LEAD_1,
        stage_to: 'contract_signed',
        pipeline: 'new_patient',
        occurred_at: new Date().toISOString(),
      },
      db,
    );

    const conversions = await db('campaign_conversions').where({ campaign_id: campaignId });
    expect(conversions).toHaveLength(0);
  });

  // ─── 4. Duplicate stage change → ON CONFLICT DO NOTHING ──

  it('inserts only one conversion row for duplicate stage changes (same lead+campaign)', async () => {
    const db = getDb();

    const sentAt = daysAgo(3);
    const occurredAt1 = daysAfter(sentAt, 1);
    const occurredAt2 = daysAfter(sentAt, 2);

    const campaign = await insertCampaign(db, {
      status: 'sending',
      sent_at: sentAt,
    });
    const campaignId = campaign.id as string;

    await insertRecipient(db, {
      campaign_id: campaignId,
      lead_id: LEAD_1,
      sent_at: sentAt,
    });

    // First call
    await handleLeadStageChanged(
      {
        lead_id: LEAD_1,
        stage_to: 'contract_signed',
        pipeline: 'new_patient',
        occurred_at: occurredAt1.toISOString(),
      },
      db,
    );

    // Second call — same lead + campaign
    await handleLeadStageChanged(
      {
        lead_id: LEAD_1,
        stage_to: 'exam_completed',
        pipeline: 'new_patient',
        occurred_at: occurredAt2.toISOString(),
      },
      db,
    );

    const conversions = await db('campaign_conversions').where({ campaign_id: campaignId });
    expect(conversions).toHaveLength(1);
    // First conversion wins (ON CONFLICT DO NOTHING)
    expect(conversions[0].stage_to).toBe('contract_signed');
  });

  // ─── 5. Late SQS processing — occurred_at anchor ─────────

  it('records conversion using occurred_at anchor even when handler runs days later', async () => {
    const db = getDb();

    // sent_at was 5 days ago
    const sentAt = daysAgo(5);
    // occurred_at was 4 days ago (1 day after sent_at — within 7-day window)
    const occurredAt = daysAfter(sentAt, 1);
    // Handler is processing this "now" — days later, but conversion should still count
    // because occurred_at (not processing time) is the anchor

    const campaign = await insertCampaign(db, {
      status: 'sending',
      sent_at: sentAt,
    });
    const campaignId = campaign.id as string;

    await insertRecipient(db, {
      campaign_id: campaignId,
      lead_id: LEAD_1,
      sent_at: sentAt,
    });

    await handleLeadStageChanged(
      {
        lead_id: LEAD_1,
        stage_to: 'exam_scheduled',
        pipeline: 'new_patient',
        occurred_at: occurredAt.toISOString(),
      },
      db,
    );

    const conversions = await db('campaign_conversions').where({ campaign_id: campaignId });
    expect(conversions).toHaveLength(1);
    expect(new Date(conversions[0].converted_at).getTime()).toBeCloseTo(occurredAt.getTime(), -3);
  });
});

// ─── Tests: A/B Open Tracking ──────────────────────────────

describe.skipIf(!HAS_DB)('A/B open tracking (integration)', () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
  });

  // ─── 6. Open tracking for A and B variants ───────────────

  it('increments ab_opens_a and ab_opens_b on email.opened events', async () => {
    const db = getDb();

    const campaign = await insertCampaign(db, {
      status: 'sending',
      sent_at: new Date(),
      ab_enabled: true,
      ab_mode: 'holdout',
      ab_phase: 'testing',
      ab_opens_a: 0,
      ab_opens_b: 0,
    });
    const campaignId = campaign.id as string;

    // Insert campaign_sends for variant A and B
    const sendA = await sendsRepo.insert(db, {
      campaign_id: campaignId,
      location_id: LOC_A,
      variant: 'A',
      subject_used: 'Subject A',
      email_job_id: 'email-job-open-a',
      email_job_ref: `${campaignId}:${LOC_A}:A`,
      status: 'sending',
      total_recipients: 10,
      sent_count: 0,
      failed_count: 0,
      started_at: new Date(),
      completed_at: null,
    });

    const sendB = await sendsRepo.insert(db, {
      campaign_id: campaignId,
      location_id: LOC_A,
      variant: 'B',
      subject_used: 'Subject B',
      email_job_id: 'email-job-open-b',
      email_job_ref: `${campaignId}:${LOC_A}:B`,
      status: 'sending',
      total_recipients: 10,
      sent_count: 0,
      failed_count: 0,
      started_at: new Date(),
      completed_at: null,
    });

    // Fire email.opened for variant A
    await handleEmailOpened(
      {
        campaign_job_id: 'email-job-open-a',
        entity_type: 'campaign',
        entity_id: campaignId,
      },
      db,
    );

    const afterA = await campaignsRepo.findById(db, campaignId);
    expect(afterA!.ab_opens_a).toBe(1);
    expect(afterA!.ab_opens_b).toBe(0);

    // Fire email.opened for variant B
    await handleEmailOpened(
      {
        campaign_job_id: 'email-job-open-b',
        entity_type: 'campaign',
        entity_id: campaignId,
      },
      db,
    );

    const afterB = await campaignsRepo.findById(db, campaignId);
    expect(afterB!.ab_opens_a).toBe(1);
    expect(afterB!.ab_opens_b).toBe(1);
  });

  // ─── 7. email.opened after ab_phase='complete' → no-op ───

  it('does NOT increment opens after ab_phase is complete', async () => {
    const db = getDb();

    const campaign = await insertCampaign(db, {
      status: 'sending',
      sent_at: new Date(),
      ab_enabled: true,
      ab_mode: 'holdout',
      ab_phase: 'complete', // already complete
      ab_opens_a: 0,
      ab_opens_b: 0,
    });
    const campaignId = campaign.id as string;

    await sendsRepo.insert(db, {
      campaign_id: campaignId,
      location_id: LOC_A,
      variant: 'A',
      subject_used: 'Subject A',
      email_job_id: 'email-job-late-a',
      email_job_ref: `${campaignId}:${LOC_A}:A`,
      status: 'sending',
      total_recipients: 10,
      sent_count: 0,
      failed_count: 0,
      started_at: new Date(),
      completed_at: null,
    });

    // Fire email.opened — should be no-op because ab_phase='complete'
    await handleEmailOpened(
      {
        campaign_job_id: 'email-job-late-a',
        entity_type: 'campaign',
        entity_id: campaignId,
      },
      db,
    );

    const after = await campaignsRepo.findById(db, campaignId);
    expect(after!.ab_opens_a).toBe(0);
    expect(after!.ab_opens_b).toBe(0);
  });
});
