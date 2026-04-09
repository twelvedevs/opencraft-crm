import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Mock external HTTP dependencies at module level
const getLeadByIdMock = vi.fn();
vi.mock('../../src/clients/lead-service.client.js', () => ({
  getLeadById: (...args: unknown[]) => getLeadByIdMock(...args),
}));

const fetchMock = vi.fn().mockResolvedValue({ ok: true });
vi.stubGlobal('fetch', fetchMock);

import {
  HAS_DB,
  runMigrations,
  cleanup,
  truncateTables,
  getDb,
  insertReferrer,
  insertReferralLink,
  insertReferral,
  LOCATION_ID,
} from './helpers.js';
import { handleLeadConverted } from '../../src/handlers/lead-converted.js';
import type { OrthoEvent, EventBus } from '@ortho/event-bus';
import type { Knex } from 'knex';

function makeConvertedEvent(overrides: Record<string, unknown> = {}): OrthoEvent {
  return {
    event_type: 'lead.converted',
    entity_type: 'lead',
    entity_id: overrides.lead_id as string ?? 'lead-1',
    payload: {
      lead_id: 'lead-1',
      location_id: LOCATION_ID,
      to_pipeline: 'in_treatment',
      converted_at: '2026-04-09T18:00:00Z',
      ...overrides,
    },
  };
}

function createMockBus(): EventBus & { published: OrthoEvent[] } {
  const published: OrthoEvent[] = [];
  return {
    published,
    async publish(event: OrthoEvent) {
      published.push(event);
    },
    subscribe() {},
    async start() {},
    async stop() {},
  };
}

// ─── Branch A: in_treatment (contract signed) ───────────────

describe.skipIf(!HAS_DB)('handleLeadConverted Branch A (integration)', () => {
  let db: Knex;
  let bus: ReturnType<typeof createMockBus>;
  let referrer: Record<string, unknown>;
  let link: Record<string, unknown>;

  beforeAll(async () => {
    db = getDb();
    await runMigrations();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({ ok: true });
    bus = createMockBus();

    referrer = await insertReferrer(db, {
      referrer_type: 'patient',
      name: 'Jane Doe',
      phone: '+15551234567',
    });
    link = await insertReferralLink(db, {
      referrer_id: referrer.id as string,
      code: 'BRANCHCD',
    });
  });

  it('advances referral to converted status with correct converted_at', async () => {
    const referral = await insertReferral(db, {
      referral_link_id: link.id as string,
      referrer_id: referrer.id as string,
      lead_id: 'lead-1',
    });

    await handleLeadConverted(
      makeConvertedEvent({ converted_at: '2026-04-09T20:00:00Z' }),
      db,
      bus,
    );

    const row = await db('referrals').where({ id: referral.id }).first();
    expect(row.status).toBe('converted');
    expect(new Date(row.converted_at).toISOString()).toBe('2026-04-09T20:00:00.000Z');
  });

  it('creates reward_events row with status=pending', async () => {
    const referral = await insertReferral(db, {
      referral_link_id: link.id as string,
      referrer_id: referrer.id as string,
      lead_id: 'lead-1',
    });

    await handleLeadConverted(makeConvertedEvent(), db, bus);

    const rewards = await db('reward_events').where({ referral_id: referral.id });
    expect(rewards).toHaveLength(1);
    expect(rewards[0].status).toBe('pending');
    expect(rewards[0].referrer_id).toBe(referrer.id);
  });

  it('publishes referral.converted event', async () => {
    await insertReferral(db, {
      referral_link_id: link.id as string,
      referrer_id: referrer.id as string,
      lead_id: 'lead-1',
    });

    await handleLeadConverted(makeConvertedEvent(), db, bus);

    expect(bus.published).toHaveLength(1);
    expect(bus.published[0].event_type).toBe('referral.converted');
    const payload = bus.published[0].payload;
    expect(payload.lead_id).toBe('lead-1');
    expect(payload.referrer_id).toBe(referrer.id);
    expect(payload.location_id).toBe(LOCATION_ID);
    expect(payload.converted_at).toBe('2026-04-09T18:00:00Z');
  });

  it('sends SMS with dedup_key for patient referrer', async () => {
    const referral = await insertReferral(db, {
      referral_link_id: link.id as string,
      referrer_id: referrer.id as string,
      lead_id: 'lead-1',
    });

    await handleLeadConverted(makeConvertedEvent(), db, bus);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.dedup_key).toBe(`referral_conversion_notify:${referral.id}`);
  });

  it('is idempotent on second delivery (reward ON CONFLICT DO NOTHING)', async () => {
    await insertReferral(db, {
      referral_link_id: link.id as string,
      referrer_id: referrer.id as string,
      lead_id: 'lead-1',
    });

    await handleLeadConverted(makeConvertedEvent(), db, bus);
    // Reset mock bus to check second invocation
    bus.published.length = 0;
    await handleLeadConverted(makeConvertedEvent(), db, bus);

    // Only one reward_events row should exist
    const rewards = await db('reward_events').select('*');
    expect(rewards).toHaveLength(1);

    // Second call still publishes event (publisher is not idempotent by design)
    // The key is no duplicate DB rows
  });

  it('skips when no referral exists for lead_id', async () => {
    const event = makeConvertedEvent({ lead_id: 'nonexistent-lead' });
    await handleLeadConverted(event, db, bus);

    const rewards = await db('reward_events').select('*');
    expect(rewards).toHaveLength(0);
    expect(bus.published).toHaveLength(0);
  });
});

// ─── Branch B: in_retention (patient referrer creation) ─────

describe.skipIf(!HAS_DB)('handleLeadConverted Branch B (integration)', () => {
  let db: Knex;
  let bus: ReturnType<typeof createMockBus>;

  beforeAll(async () => {
    db = getDb();
    await runMigrations();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({ ok: true });
    bus = createMockBus();

    getLeadByIdMock.mockResolvedValue({
      first_name: 'John',
      last_name: 'Smith',
      phone: '+15559876543',
      location_id: LOCATION_ID,
    });
  });

  it('creates referrers row and referral_links row', async () => {
    const event = makeConvertedEvent({
      to_pipeline: 'in_retention',
      lead_id: 'lead-b1',
    });

    await handleLeadConverted(event, db, bus);

    const referrers = await db('referrers').where({ lead_id: 'lead-b1' });
    expect(referrers).toHaveLength(1);
    expect(referrers[0].referrer_type).toBe('patient');
    expect(referrers[0].name).toBe('John Smith');
    expect(referrers[0].phone).toBe('+15559876543');
    expect(referrers[0].created_by).toBeNull();

    const links = await db('referral_links').where({ referrer_id: referrers[0].id });
    expect(links).toHaveLength(1);
    expect(links[0].status).toBe('active');
    expect(links[0].redirect_url).toBe('https://example.com/referrals');
  });

  it('publishes referrer.created with referral_link_url containing /referrals/r/<code>', async () => {
    const event = makeConvertedEvent({
      to_pipeline: 'in_retention',
      lead_id: 'lead-b2',
    });

    await handleLeadConverted(event, db, bus);

    expect(bus.published).toHaveLength(1);
    expect(bus.published[0].event_type).toBe('referrer.created');
    const payload = bus.published[0].payload;
    expect(payload.referrer_type).toBe('patient');
    expect(payload.lead_id).toBe('lead-b2');
    expect(payload.location_id).toBe(LOCATION_ID);
    // URL must be the redirect endpoint path, not a ?ref= landing page URL
    expect(payload.referral_link_url).toMatch(/\/referrals\/r\/[A-Za-z0-9]{8}$/);
    expect(payload.referral_link_url).not.toContain('?ref=');
  });

  it('is idempotent — second delivery skips when referrers row already exists', async () => {
    const event = makeConvertedEvent({
      to_pipeline: 'in_retention',
      lead_id: 'lead-b3',
    });

    await handleLeadConverted(event, db, bus);
    const firstCallPublished = bus.published.length;

    bus.published.length = 0;
    await handleLeadConverted(event, db, bus);

    // Only one referrer row
    const referrers = await db('referrers').where({ lead_id: 'lead-b3' });
    expect(referrers).toHaveLength(1);

    // Second call should not publish (skips early)
    expect(bus.published).toHaveLength(0);
    expect(firstCallPublished).toBe(1);
  });

  it('rethrows on Lead Service call failure (dead-letters)', async () => {
    getLeadByIdMock.mockRejectedValue(new Error('Lead Service unavailable'));

    const event = makeConvertedEvent({
      to_pipeline: 'in_retention',
      lead_id: 'lead-b4',
    });

    await expect(handleLeadConverted(event, db, bus)).rejects.toThrow(
      'Lead Service unavailable',
    );

    // No referrer created
    const referrers = await db('referrers').where({ lead_id: 'lead-b4' });
    expect(referrers).toHaveLength(0);
  });
});
