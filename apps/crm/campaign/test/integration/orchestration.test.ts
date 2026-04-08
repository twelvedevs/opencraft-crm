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
import { orchestrateNonAB } from '../../src/services/send-orchestrator.js';
import { handleEmailCampaignCompleted } from '../../src/handlers/email-campaign-completed.handler.js';
import * as campaignsRepo from '../../src/repositories/campaigns.repo.js';
import * as sendsRepo from '../../src/repositories/campaign-sends.repo.js';
import { insertEvent } from '../../src/repositories/campaign-events.repo.js';
import { createEventBus, MockDriver } from '@ortho/event-bus';
import { env } from '../../src/env.js';

// ─── Constants ──────────────────────────────────────────────

const LOC_A = '00000000-0000-0000-0000-00000000000a';
const LOC_B = '00000000-0000-0000-0000-00000000000b';
const LOC_C = '00000000-0000-0000-0000-00000000000c';

function makeLead(id: string, locationId: string): LeadContact {
  return { id, email: `${id}@test.com`, first_name: id, location_id: locationId };
}

// ─── Fetch mock helper ──────────────────────────────────────

interface MockFetchOpts {
  leads: LeadContact[];
  matchedLeadIds: string[];
  emailJobIdMap?: Map<string, string>;
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

    // Lead Service — paginated list
    if (url.includes('/leads') && url.includes('contact_status')) {
      const u = new URL(url);
      const offset = parseInt(u.searchParams.get('offset') ?? '0', 10);
      const limit = parseInt(u.searchParams.get('limit') ?? '500', 10);
      const page = opts.leads.slice(offset, offset + limit);
      return new Response(JSON.stringify({ items: page }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Lead Service — by IDs
    if (url.includes('/leads') && url.includes('ids=')) {
      const u = new URL(url);
      const ids = u.searchParams.get('ids')!.split(',');
      const matched = opts.leads.filter((l) => ids.includes(l.id));
      return new Response(JSON.stringify({ items: matched }), {
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
      const jobId =
        opts.emailJobIdMap?.get(body.location_id as string) ??
        `email-job-${emailCallCounter}`;
      return new Response(JSON.stringify({ job_id: jobId }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unmocked fetch: ${method} ${url}`);
  };

  return { mock, emailCalls };
}

// ─── Helper: simulate worker processJob steps ──────────────

async function fireWorkerLogic(
  db: ReturnType<typeof getDb>,
  campaignId: string,
): Promise<{
  groupedByLocation: Map<string, LeadContact[]>;
  snapshotId: string;
  isEmpty: boolean;
}> {
  // Step 2 — status transition (same SQL as the real worker)
  await db('campaigns')
    .where({ id: campaignId })
    .whereIn('status', ['scheduled', 'sending'])
    .update({
      status: 'sending',
      sent_at: db.raw('COALESCE(sent_at, now())'),
      updated_at: db.fn.now(),
    });

  // Steps 4-7 — audience resolution
  const campaign = (await campaignsRepo.findById(db, campaignId))!;
  const { snapshotId, groupedByLocation } = await resolveAudience(db, campaign, env);
  await campaignsRepo.update(db, campaignId, { audience_snapshot_id: snapshotId });

  // Step 8 — empty audience guard
  if (groupedByLocation.size === 0) {
    await campaignsRepo.update(db, campaignId, {
      status: 'failed',
      completed_at: new Date(),
    });
    await insertEvent(db, {
      campaign_id: campaignId,
      from_status: 'sending',
      to_status: 'failed',
      actor_id: null,
      comment: 'empty_audience',
    });
    return { groupedByLocation, snapshotId, isEmpty: true };
  }

  // Steps 9-11 — non-A/B send orchestration
  await orchestrateNonAB(db, campaign, groupedByLocation, env);
  return { groupedByLocation, snapshotId, isEmpty: false };
}

// ─── Tests ──────────────────────────────────────────────────

describe.skipIf(!HAS_DB || !HAS_REDIS)('orchestration (integration)', () => {
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

  // ─── 1. non-A/B happy path ───────────────────────────────

  it('non-A/B happy path — send-now → worker → completed', async () => {
    const db = getDb();

    // Insert approved campaign
    const campaign = await insertCampaign(db, { status: 'approved' });
    const campaignId = campaign.id as string;

    // POST /send-now via API (needs real Redis for Queue.add)
    const sendRes = await app.inject({
      method: 'POST',
      url: `/campaigns/${campaignId}/send-now`,
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(sendRes.statusCode).toBe(200);
    expect(sendRes.json().status).toBe('sending');

    // Verify orchestrate_job_id was stored
    const afterSendNow = await campaignsRepo.findById(db, campaignId);
    expect(afterSendNow!.orchestrate_job_id).toBeTruthy();

    // Mock external services
    const lead = makeLead('lead-1', LOCATION_ID);
    const { mock, emailCalls } = createServiceFetchMock(savedFetch, {
      leads: [lead],
      matchedLeadIds: ['lead-1'],
    });
    globalThis.fetch = mock;

    // Manually fire worker job
    const { isEmpty } = await fireWorkerLogic(db, campaignId);
    expect(isEmpty).toBe(false);

    // Assert 1 Email Service call
    expect(emailCalls).toHaveLength(1);

    // Assert campaign_sends row inserted
    const sends = await sendsRepo.findAllByCampaignId(db, campaignId);
    expect(sends).toHaveLength(1);
    expect(sends[0].email_job_id).toBe('email-job-1');
    expect(sends[0].status).toBe('sending');

    // Assert campaign_recipients row inserted
    const recipients = await db('campaign_recipients').where({
      campaign_id: campaignId,
    });
    expect(recipients).toHaveLength(1);
    expect(recipients[0].lead_id).toBe('lead-1');

    // Fire email.campaign_completed handler
    const driver = new MockDriver();
    const bus = createEventBus({ driver });
    await handleEmailCampaignCompleted(
      {
        job_id: 'email-job-1',
        status: 'completed',
        sent_count: 1,
        failed_count: 0,
        total_recipients: 1,
        completed_at: new Date().toISOString(),
      },
      db,
      bus,
    );

    // Assert terminal status
    const finalCampaign = await campaignsRepo.findById(db, campaignId);
    expect(finalCampaign!.status).toBe('completed');
    expect(finalCampaign!.completed_at).not.toBeNull();

    // Assert campaign_events has terminal row
    const events = await db('campaign_events')
      .where({ campaign_id: campaignId })
      .orderBy('created_at', 'asc');
    const terminalEvent = events.find(
      (e: Record<string, unknown>) => e.to_status === 'completed',
    );
    expect(terminalEvent).toBeDefined();
    expect(terminalEvent.from_status).toBe('sending');
  });

  // ─── 2. empty audience ───────────────────────────────────

  it('empty audience — worker marks campaign as failed', async () => {
    const db = getDb();

    const campaign = await insertCampaign(db, {
      status: 'sending',
      sent_at: new Date(),
    });
    const campaignId = campaign.id as string;

    // Leads exist but none match the audience (snapshot returns empty)
    const lead = makeLead('lead-1', LOCATION_ID);
    const { mock } = createServiceFetchMock(savedFetch, {
      leads: [lead],
      matchedLeadIds: [],
    });
    globalThis.fetch = mock;

    // Fire worker logic
    const { isEmpty } = await fireWorkerLogic(db, campaignId);
    expect(isEmpty).toBe(true);

    // Assert campaign failed
    const finalCampaign = await campaignsRepo.findById(db, campaignId);
    expect(finalCampaign!.status).toBe('failed');

    // Assert campaign_events has empty_audience comment
    const events = await db('campaign_events').where({ campaign_id: campaignId });
    const failedEvent = events.find(
      (e: Record<string, unknown>) => e.to_status === 'failed',
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent.comment).toBe('empty_audience');
  });

  // ─── 3. multi-location (3 locations) ─────────────────────

  it('multi-location — 3 sends, 3 completions → completed', async () => {
    const db = getDb();

    const campaign = await insertCampaign(db, {
      status: 'sending',
      sent_at: new Date(),
    });
    const campaignId = campaign.id as string;

    const leads = [
      makeLead('lead-a1', LOC_A),
      makeLead('lead-a2', LOC_A),
      makeLead('lead-b1', LOC_B),
      makeLead('lead-c1', LOC_C),
    ];
    const matchedIds = leads.map((l) => l.id);

    const emailJobMap = new Map<string, string>([
      [LOC_A, 'ej-a'],
      [LOC_B, 'ej-b'],
      [LOC_C, 'ej-c'],
    ]);

    const { mock, emailCalls } = createServiceFetchMock(savedFetch, {
      leads,
      matchedLeadIds: matchedIds,
      emailJobIdMap: emailJobMap,
    });
    globalThis.fetch = mock;

    // Fire worker
    await fireWorkerLogic(db, campaignId);

    // Assert 3 Email Service calls (one per location)
    expect(emailCalls).toHaveLength(3);

    // Assert 3 campaign_sends rows
    const sends = await sendsRepo.findAllByCampaignId(db, campaignId);
    expect(sends).toHaveLength(3);

    // Assert 4 total recipients (2 + 1 + 1)
    const recipients = await db('campaign_recipients').where({
      campaign_id: campaignId,
    });
    expect(recipients).toHaveLength(4);

    // Fire 3 email.campaign_completed events
    const driver = new MockDriver();
    const bus = createEventBus({ driver });

    for (const [locId, jobId] of emailJobMap) {
      const locLeads = leads.filter((l) => l.location_id === locId);
      await handleEmailCampaignCompleted(
        {
          job_id: jobId,
          status: 'completed',
          sent_count: locLeads.length,
          failed_count: 0,
          total_recipients: locLeads.length,
          completed_at: new Date().toISOString(),
        },
        db,
        bus,
      );
    }

    // Assert terminal status
    const finalCampaign = await campaignsRepo.findById(db, campaignId);
    expect(finalCampaign!.status).toBe('completed');
    expect(finalCampaign!.completed_at).not.toBeNull();

    // Assert campaign_events terminal row
    const events = await db('campaign_events')
      .where({ campaign_id: campaignId })
      .orderBy('created_at', 'asc');
    const terminalEvent = events.find(
      (e: Record<string, unknown>) => e.to_status === 'completed',
    );
    expect(terminalEvent).toBeDefined();
  });

  // ─── 4. crash recovery ───────────────────────────────────

  it('crash recovery — skips locations with existing sends', async () => {
    const db = getDb();

    const campaign = await insertCampaign(db, {
      status: 'sending',
      sent_at: new Date(),
      audience_snapshot_id: 'old-snapshot-id',
    });
    const campaignId = campaign.id as string;

    // Pre-insert 2 of 3 campaign_sends (simulating partial completion before crash)
    await sendsRepo.insert(db, {
      campaign_id: campaignId,
      location_id: LOC_A,
      variant: null,
      subject_used: 'Test Subject',
      email_job_id: 'ej-a',
      email_job_ref: `${campaignId}:${LOC_A}`,
      status: 'sending',
      total_recipients: 2,
      sent_count: 0,
      failed_count: 0,
      started_at: new Date(),
      completed_at: null,
    });
    await sendsRepo.insert(db, {
      campaign_id: campaignId,
      location_id: LOC_B,
      variant: null,
      subject_used: 'Test Subject',
      email_job_id: 'ej-b',
      email_job_ref: `${campaignId}:${LOC_B}`,
      status: 'sending',
      total_recipients: 1,
      sent_count: 0,
      failed_count: 0,
      started_at: new Date(),
      completed_at: null,
    });

    // Pre-insert recipients for existing sends
    await db.batchInsert(
      'campaign_recipients',
      [
        { campaign_id: campaignId, lead_id: 'lead-a1', email: 'lead-a1@test.com', location_id: LOC_A, variant: null },
        { campaign_id: campaignId, lead_id: 'lead-a2', email: 'lead-a2@test.com', location_id: LOC_A, variant: null },
        { campaign_id: campaignId, lead_id: 'lead-b1', email: 'lead-b1@test.com', location_id: LOC_B, variant: null },
      ],
      1000,
    );

    // Leads across 3 locations
    const leads = [
      makeLead('lead-a1', LOC_A),
      makeLead('lead-a2', LOC_A),
      makeLead('lead-b1', LOC_B),
      makeLead('lead-c1', LOC_C),
    ];
    const matchedIds = leads.map((l) => l.id);

    const { mock, emailCalls } = createServiceFetchMock(savedFetch, {
      leads,
      matchedLeadIds: matchedIds,
      emailJobIdMap: new Map([[LOC_C, 'ej-c']]),
    });
    globalThis.fetch = mock;

    // Fire worker (re-resolves audience, then orchestrateNonAB skips existing sends)
    await fireWorkerLogic(db, campaignId);

    // Assert only 1 new Email Service call (LOC_C only)
    expect(emailCalls).toHaveLength(1);
    expect(emailCalls[0].body.location_id).toBe(LOC_C);

    // Assert 3 total campaign_sends (2 pre-existing + 1 new)
    const sends = await sendsRepo.findAllByCampaignId(db, campaignId);
    expect(sends).toHaveLength(3);

    // Assert no duplicate recipients — 3 pre-existing + 1 new = 4 total
    const recipients = await db('campaign_recipients').where({
      campaign_id: campaignId,
    });
    expect(recipients).toHaveLength(4);
  });
});
