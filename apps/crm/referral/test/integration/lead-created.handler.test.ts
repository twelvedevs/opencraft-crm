import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Mock external HTTP dependencies at module level
vi.mock('../../src/clients/lead-service.client.js', () => ({
  getLeadById: vi.fn(),
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
  LOCATION_ID,
} from './helpers.js';
import { handleLeadCreated } from '../../src/handlers/lead-created.js';
import type { OrthoEvent } from '@ortho/event-bus';
import type { Knex } from 'knex';

function makeLeadCreatedEvent(overrides: Record<string, unknown> = {}): OrthoEvent {
  return {
    event_type: 'lead.created',
    entity_type: 'lead',
    entity_id: overrides.lead_id as string ?? 'lead-1',
    payload: {
      lead_id: 'lead-1',
      location_id: LOCATION_ID,
      referrer_id: 'referrer-1',
      referral_code: 'TESTCODE',
      ...overrides,
    },
  };
}

describe.skipIf(!HAS_DB)('handleLeadCreated (integration)', () => {
  let db: Knex;
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

    // Set up referrer + link for test use
    referrer = await insertReferrer(db);
    link = await insertReferralLink(db, {
      referrer_id: referrer.id as string,
      code: 'TESTCODE',
    });
  });

  it('creates referrals row pinned to the specific referral_link matching referral_code', async () => {
    // Create a second link to verify we pin to the specific code
    const link2 = await insertReferralLink(db, {
      referrer_id: referrer.id as string,
      code: 'OTHERCD1',
    });

    const event = makeLeadCreatedEvent({
      referrer_id: referrer.id,
      referral_code: 'TESTCODE',
    });

    await handleLeadCreated(event, db);

    const rows = await db('referrals').where({ lead_id: 'lead-1' });
    expect(rows).toHaveLength(1);
    expect(rows[0].referral_link_id).toBe(link.id);
    expect(rows[0].referral_link_id).not.toBe(link2.id);
    expect(rows[0].referrer_id).toBe(referrer.id);
    expect(rows[0].location_id).toBe(LOCATION_ID);
    expect(rows[0].status).toBe('pending');
  });

  it('skips when referral_code is unknown — no row created', async () => {
    const event = makeLeadCreatedEvent({
      referrer_id: referrer.id,
      referral_code: 'UNKNOWN1',
    });

    await handleLeadCreated(event, db);

    const rows = await db('referrals').select('*');
    expect(rows).toHaveLength(0);
  });

  it('skips when referrer_id is null', async () => {
    const event = makeLeadCreatedEvent({
      referrer_id: null,
      referral_code: 'TESTCODE',
    });

    await handleLeadCreated(event, db);

    const rows = await db('referrals').select('*');
    expect(rows).toHaveLength(0);
  });

  it('skips when referral_code is null', async () => {
    const event = makeLeadCreatedEvent({
      referrer_id: referrer.id,
      referral_code: null,
    });

    await handleLeadCreated(event, db);

    const rows = await db('referrals').select('*');
    expect(rows).toHaveLength(0);
  });

  it('is idempotent on duplicate delivery (ON CONFLICT DO NOTHING)', async () => {
    const event = makeLeadCreatedEvent({
      referrer_id: referrer.id,
      referral_code: 'TESTCODE',
    });

    await handleLeadCreated(event, db);
    await handleLeadCreated(event, db);

    const rows = await db('referrals').where({ lead_id: 'lead-1' });
    expect(rows).toHaveLength(1);
  });
});
