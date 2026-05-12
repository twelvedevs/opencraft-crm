import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  HAS_DB,
  HAS_REDIS,
  buildTestApp,
  runMigrations,
  cleanup,
  truncateTables,
  makeJwt,
  getDb,
  insertCampaign,
  LOCATION_ID,
  MANAGER_ID,
} from './helpers.js';
import { resolveAudience, type LeadContact } from '../../src/services/audience-resolver.js';
import { orchestrateAB } from '../../src/services/send-orchestrator.js';
import { handleEmailCampaignCompleted } from '../../src/handlers/email-campaign-completed.handler.js';
import { selectWinner } from '../../src/services/ab-winner.js';
import * as campaignsRepo from '../../src/repositories/campaigns.repo.js';
import * as sendsRepo from '../../src/repositories/campaign-sends.repo.js';
import * as recipientsRepo from '../../src/repositories/campaign-recipients.repo.js';
import { createEventBus, MockDriver } from '@ortho/event-bus';
import { env } from '../../src/env.js';
import type { Knex } from 'knex';

// ─── Constants ──────────────────────────────────────────────

const LOC_A = '00000000-0000-0000-0000-00000000000a';
const LOC_B = '00000000-0000-0000-0000-00000000000b';

function makeLead(id: string, locationId: string): LeadContact {
  return { id, email: `${id}@test.com`, first_name: id, location_id: locationId };
}

function makeLeads(count: number, locationId: string, prefix: string): LeadContact[] {
  return Array.from({ length: count }, (_, i) =>
    makeLead(`${prefix}-${i + 1}`, locationId),
  );
}

// ─── Fetch mock helper ──────────────────────────────────────

interface MockFetchOpts {
  leads: LeadContact[];
  matchedLeadIds: string[];
}

function createServiceFetchMock(
  savedFetch: typeof globalThis.fetch,
  opts: MockFetchOpts,
) {
  const emailCalls: { url: string; body: Record<string, unknown> }[] = [];
  let emailCallCounter = 0;

  const mock: typeof globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = init?.method?.toUpperCase() ?? 'GET';

    // JWKS — delegate to the auth mock set up by buildTestApp
    if (url.includes('.well-known/jwks.json') || url.includes('/jwks')) {
      return savedFetch(input, init);
    }

    // Lead Service — paginated list (cursor-based)
    if (url.includes('/leads') && url.includes('contact_status')) {
      const u = new URL(url);
      const cursor = u.searchParams.get('cursor');
      const limit = parseInt(u.searchParams.get('limit') ?? '200', 10);
      const offset = cursor ? parseInt(cursor, 10) : 0;
      const page = opts.leads.slice(offset, offset + limit);
      const nextOffset = offset + limit;
      const nextCursor = nextOffset < opts.leads.length ? String(nextOffset) : null;
      return new Response(JSON.stringify({ data: page, nextCursor }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Lead Service — by IDs
    if (url.includes('/leads') && url.includes('ids=')) {
      const u = new URL(url);
      const ids = u.searchParams.get('ids')!.split(',');
      const matched = opts.leads.filter((l) => ids.includes(l.id));
      return new Response(JSON.stringify({ data: matched }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Audience Engine — evaluate (POST)
    if (
      method === 'POST' &&
      (url.includes('/audiences/segments/') || url.includes('/audiences/evaluate'))
    ) {
      return new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Audience Engine — snapshot (GET)
    if (url.includes('/audiences/snapshots/')) {
      return new Response(JSON.stringify({ entity_ids: opts.matchedLeadIds }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Email Service — send campaign
    if (method === 'POST' && url.includes('/emails/campaigns/send')) {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      emailCalls.push({ url, body });
      emailCallCounter++;
      const jobId = `email-job-${emailCallCounter}`;
      return new Response(JSON.stringify({ job_id: jobId }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unmocked fetch: ${method} ${url}`);
  };

  return { mock, emailCalls };
}

// ─── Helper: simulate A/B worker processJob steps ──────────

async function fireABWorkerLogic(
  db: Knex,
  campaignId: string,
): Promise<{
  groupedByLocation: Map<string, LeadContact[]>;
  snapshotId: string;
  isEmpty: boolean;
}> {
  // Status transition (same SQL as the real worker)
  await db('campaigns')
    .where({ id: campaignId })
    .whereIn('status', ['scheduled', 'sending'])
    .update({
      status: 'sending',
      sent_at: db.raw('COALESCE(sent_at, now())'),
      updated_at: db.fn.now(),
    });

  // Audience resolution
  const campaign = (await campaignsRepo.findById(db, campaignId))!;
  const { snapshotId, groupedByLocation } = await resolveAudience(db, campaign, env);
  await campaignsRepo.update(db, campaignId, { audience_snapshot_id: snapshotId });

  // Empty audience guard
  if (groupedByLocation.size === 0) {
    await campaignsRepo.update(db, campaignId, {
      status: 'failed',
      completed_at: new Date(),
    });
    return { groupedByLocation, snapshotId, isEmpty: true };
  }

  // A/B send orchestration
  await orchestrateAB(db, campaign, groupedByLocation, env);

  // Post-orchestration phase updates (mirrors real worker logic)
  if (campaign.ab_mode === 'holdout') {
    await campaignsRepo.update(db, campaignId, {
      ab_phase: 'testing',
      ab_decision_at: new Date(Date.now() + (campaign.ab_winner_delay_hours ?? 1) * 3600000),
    });
  } else {
    await campaignsRepo.update(db, campaignId, {
      ab_phase: 'complete',
    });
  }

  return { groupedByLocation, snapshotId, isEmpty: false };
}

// ─── Helper: simulate ab-winner-select processJob ──────────
// Replicates src/workers/ab-winner-select.worker.ts processJob
// but uses the test's Knex instance (avoids Worker module side effects)

async function fireABWinnerSelect(db: Knex, campaignId: string): Promise<void> {
  const campaign = await campaignsRepo.findById(db, campaignId);
  if (!campaign) return;
  if (campaign.status !== 'sending' || campaign.ab_phase !== 'testing') return;

  // Compute winner
  const allSends = await sendsRepo.findAllByCampaignId(db, campaignId);
  const countA = allSends
    .filter((s) => s.variant === 'A')
    .reduce((sum, s) => sum + s.total_recipients, 0);
  const countB = allSends
    .filter((s) => s.variant === 'B')
    .reduce((sum, s) => sum + s.total_recipients, 0);

  const winner = selectWinner(campaign.ab_opens_a, countA, campaign.ab_opens_b, countB);

  await campaignsRepo.update(db, campaignId, {
    ab_winner: winner,
    ab_phase: 'complete',
    ab_decision_at: new Date(),
  });

  // Dispatch holdout sends
  const winningSubject = winner === 'A'
    ? (campaign.ab_variant_a_subject ?? campaign.subject ?? '')
    : (campaign.ab_variant_b_subject ?? campaign.subject ?? '');

  const holdoutRecipients = await db('campaign_recipients')
    .where({ campaign_id: campaignId, variant: 'holdout' })
    .select('*') as recipientsRepo.CampaignRecipient[];

  const byLocation = new Map<string, recipientsRepo.CampaignRecipient[]>();
  for (const r of holdoutRecipients) {
    const list = byLocation.get(r.location_id) ?? [];
    list.push(r);
    byLocation.set(r.location_id, list);
  }

  const now = new Date();

  for (const [locationId, recipients] of byLocation) {
    const holdoutRef = `${campaignId}:${locationId}:holdout`;

    const existing = await sendsRepo.findByEmailJobRef(db, holdoutRef);
    if (existing) continue;

    const res = await fetch(`${env.EMAIL_SERVICE_URL}/emails/campaigns/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_ref: holdoutRef,
        location_id: locationId,
        template_id: campaign.template_id,
        subject_template: winningSubject,
        recipients: recipients.map((r) => ({
          id: r.lead_id,
          email: r.email,
        })),
        entity_type: 'campaign',
        entity_id: campaignId,
      }),
    });

    if (!res.ok) continue;

    const body = (await res.json()) as { job_id: string };

    await sendsRepo.insert(db, {
      campaign_id: campaignId,
      location_id: locationId,
      variant: 'holdout',
      subject_used: winningSubject,
      email_job_id: body.job_id,
      email_job_ref: holdoutRef,
      status: 'sending',
      total_recipients: recipients.length,
      sent_count: 0,
      failed_count: 0,
      started_at: now,
      completed_at: null,
    });

    await recipientsRepo.updateSentAt(db, campaignId, 'holdout', locationId, now);
  }
}

// ─── Tests ──────────────────────────────────────────────────

describe.skipIf(!HAS_DB || !HAS_REDIS)('A/B orchestration (integration)', () => {
  let app: FastifyInstance;
  let managerToken: string;
  let savedFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    await runMigrations();
    app = await buildTestApp();
    await app.ready();
    managerToken = makeJwt({
      sub: MANAGER_ID,
      role: 'marketing_manager',
      locations: [LOCATION_ID],
    });
    savedFetch = globalThis.fetch;
  });

  afterAll(async () => {
    globalThis.fetch = savedFetch;
    await app.close();
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  // ─── 1. A/B holdout happy path ───────────────────────────

  it('A/B holdout — orchestrate → winner select → holdout send → completed', async () => {
    const db = getDb();

    // 100 leads per location × 2 locations = 200 total
    const leadsA = makeLeads(100, LOC_A, 'la');
    const leadsB = makeLeads(100, LOC_B, 'lb');
    const allLeads = [...leadsA, ...leadsB];
    const matchedIds = allLeads.map((l) => l.id);

    // Insert campaign with A/B holdout config (split=10%)
    const campaign = await insertCampaign(db, {
      status: 'sending',
      sent_at: new Date(),
      ab_enabled: true,
      ab_mode: 'holdout',
      ab_test_split_pct: 10,
      ab_winner_delay_hours: 1,
      ab_variant_a_subject: 'Subject A',
      ab_variant_b_subject: 'Subject B',
    });
    const campaignId = campaign.id as string;

    // Mock services
    const { mock, emailCalls } = createServiceFetchMock(savedFetch, {
      leads: allLeads,
      matchedLeadIds: matchedIds,
    });
    globalThis.fetch = mock;

    // Fire A/B worker logic
    const { isEmpty } = await fireABWorkerLogic(db, campaignId);
    expect(isEmpty).toBe(false);

    // floor(100 * 10 / 100) = 10 → A=10, B=10, holdout=80 per location
    // 2 locations × 2 variants (A+B) = 4 Email Service calls
    expect(emailCalls).toHaveLength(4);

    // Assert 4 campaign_sends rows (A and B per location)
    const sends = await sendsRepo.findAllByCampaignId(db, campaignId);
    expect(sends).toHaveLength(4);
    expect(sends.filter((s) => s.variant === 'A')).toHaveLength(2);
    expect(sends.filter((s) => s.variant === 'B')).toHaveLength(2);

    // Assert recipients: 2 locations × (10 A + 10 B + 80 holdout) = 200 total
    const recipients = await db('campaign_recipients').where({ campaign_id: campaignId });
    expect(recipients).toHaveLength(200);

    // Holdout recipients should have sent_at=NULL
    const holdoutRecipients = recipients.filter(
      (r: Record<string, unknown>) => r.variant === 'holdout',
    );
    expect(holdoutRecipients).toHaveLength(160);
    for (const r of holdoutRecipients) {
      expect(r.sent_at).toBeNull();
    }

    // Assert ab_phase='testing' after orchestration
    const afterOrchestration = await campaignsRepo.findById(db, campaignId);
    expect(afterOrchestration!.ab_phase).toBe('testing');

    // ─── Simulate opens: set ab_opens_a=5, ab_opens_b=3 ────
    await campaignsRepo.update(db, campaignId, {
      ab_opens_a: 5,
      ab_opens_b: 3,
    });

    // Call ab-winner-select logic
    await fireABWinnerSelect(db, campaignId);

    // Assert ab_winner='A' (rateA = 5/20 = 0.25 > rateB = 3/20 = 0.15)
    const afterWinner = await campaignsRepo.findById(db, campaignId);
    expect(afterWinner!.ab_winner).toBe('A');
    expect(afterWinner!.ab_phase).toBe('complete');
    expect(afterWinner!.ab_decision_at).not.toBeNull();

    // Assert holdout campaign_sends rows exist (2 holdout sends, one per location)
    const allSends = await sendsRepo.findAllByCampaignId(db, campaignId);
    expect(allSends).toHaveLength(6); // 4 original + 2 holdout
    const holdoutSends = allSends.filter((s) => s.variant === 'holdout');
    expect(holdoutSends).toHaveLength(2);

    // Assert holdout recipients now have sent_at IS NOT NULL
    const holdoutRecipientsAfter = await db('campaign_recipients')
      .where({ campaign_id: campaignId, variant: 'holdout' });
    for (const r of holdoutRecipientsAfter) {
      expect(r.sent_at).not.toBeNull();
    }

    // ─── Fire completions for all 6 sends → terminal status ─
    const driver = new MockDriver();
    const bus = createEventBus({ driver });

    const finalSends = await sendsRepo.findAllByCampaignId(db, campaignId);
    for (const send of finalSends) {
      if (!send.email_job_id) continue;
      await handleEmailCampaignCompleted(
        {
          job_id: send.email_job_id,
          status: 'completed',
          sent_count: send.total_recipients,
          failed_count: 0,
          total_recipients: send.total_recipients,
          completed_at: new Date().toISOString(),
        },
        db,
        bus,
      );
    }

    // Assert terminal status = 'completed'
    const finalCampaign = await campaignsRepo.findById(db, campaignId);
    expect(finalCampaign!.status).toBe('completed');
    expect(finalCampaign!.completed_at).not.toBeNull();
  });

  // ─── 2. A/B full_split happy path ────────────────────────

  it('A/B full_split — all sent immediately → retrospective winner → completed', async () => {
    const db = getDb();

    // 100 leads per location × 2 locations
    const leadsA = makeLeads(100, LOC_A, 'la');
    const leadsB = makeLeads(100, LOC_B, 'lb');
    const allLeads = [...leadsA, ...leadsB];
    const matchedIds = allLeads.map((l) => l.id);

    const campaign = await insertCampaign(db, {
      status: 'sending',
      sent_at: new Date(),
      ab_enabled: true,
      ab_mode: 'full_split',
      ab_variant_a_subject: 'Subject A',
      ab_variant_b_subject: 'Subject B',
    });
    const campaignId = campaign.id as string;

    const { mock, emailCalls } = createServiceFetchMock(savedFetch, {
      leads: allLeads,
      matchedLeadIds: matchedIds,
    });
    globalThis.fetch = mock;

    const { isEmpty } = await fireABWorkerLogic(db, campaignId);
    expect(isEmpty).toBe(false);

    // full_split: floor(100/2)=50 per location → A=50, B=50 per location
    // 2 locations × 2 variants = 4 Email Service calls
    expect(emailCalls).toHaveLength(4);

    // Assert 4 campaign_sends
    const sends = await sendsRepo.findAllByCampaignId(db, campaignId);
    expect(sends).toHaveLength(4);

    // All recipients have sent_at IS NOT NULL (no holdout in full_split)
    const recipients = await db('campaign_recipients').where({ campaign_id: campaignId });
    expect(recipients).toHaveLength(200);
    for (const r of recipients) {
      expect(r.sent_at).not.toBeNull();
    }

    // No holdout recipients
    const holdoutCount = recipients.filter(
      (r: Record<string, unknown>) => r.variant === 'holdout',
    ).length;
    expect(holdoutCount).toBe(0);

    // ab_phase='complete' set immediately (no ab-winner-select enqueued)
    const afterOrchestration = await campaignsRepo.findById(db, campaignId);
    expect(afterOrchestration!.ab_phase).toBe('complete');

    // Simulate opens for retrospective winner computation
    await campaignsRepo.update(db, campaignId, {
      ab_opens_a: 3,
      ab_opens_b: 7,
    });

    // Fire completions for all 4 sends
    const driver = new MockDriver();
    const bus = createEventBus({ driver });

    for (const send of sends) {
      await handleEmailCampaignCompleted(
        {
          job_id: send.email_job_id!,
          status: 'completed',
          sent_count: send.total_recipients,
          failed_count: 0,
          total_recipients: send.total_recipients,
          completed_at: new Date().toISOString(),
        },
        db,
        bus,
      );
    }

    // Assert terminal status and retrospective winner
    // countA = 50+50 = 100, countB = 50+50 = 100
    // selectWinner(3, 100, 7, 100) → rateA=0.03, rateB=0.07 → B wins
    const finalCampaign = await campaignsRepo.findById(db, campaignId);
    expect(finalCampaign!.status).toBe('completed');
    expect(finalCampaign!.completed_at).not.toBeNull();
    expect(finalCampaign!.ab_winner).toBe('B');
  });

  // ─── 3. Cancel in sending state (A/B in progress) ────────

  it('cancel in sending state (A/B in progress) → 409', async () => {
    const db = getDb();

    const campaign = await insertCampaign(db, {
      status: 'sending',
      sent_at: new Date(),
      ab_enabled: true,
      ab_mode: 'holdout',
      ab_phase: 'testing',
    });
    const campaignId = campaign.id as string;

    const res = await app.inject({
      method: 'POST',
      url: `/campaigns/${campaignId}/cancel`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(409);
  });

  // ─── 4. ab-winner-select for cancelled campaign ──────────

  it('ab-winner-select fires for cancelled campaign — ACK clean, no mutations', async () => {
    const db = getDb();

    const campaign = await insertCampaign(db, {
      status: 'cancelled',
      ab_enabled: true,
      ab_mode: 'holdout',
      ab_phase: 'testing',
      ab_opens_a: 5,
      ab_opens_b: 3,
    });
    const campaignId = campaign.id as string;

    // Snapshot state before
    const before = await campaignsRepo.findById(db, campaignId);

    // Call ab-winner-select logic (replicating processJob)
    await fireABWinnerSelect(db, campaignId);

    // Assert no DB mutations occurred
    const after = await campaignsRepo.findById(db, campaignId);
    expect(after!.status).toBe('cancelled');
    expect(after!.ab_winner).toBeNull();
    expect(after!.ab_phase).toBe('testing');
    expect(after!.ab_decision_at).toEqual(before!.ab_decision_at);

    // No campaign_sends created
    const sends = await sendsRepo.findAllByCampaignId(db, campaignId);
    expect(sends).toHaveLength(0);
  });
});
