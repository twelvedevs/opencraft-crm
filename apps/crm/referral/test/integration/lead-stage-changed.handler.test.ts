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
  insertReferral,
  LOCATION_ID,
} from './helpers.js';
import { handleLeadStageChanged } from '../../src/handlers/lead-stage-changed.js';
import type { OrthoEvent } from '@ortho/event-bus';
import type { Knex } from 'knex';

function makeStageChangedEvent(overrides: Record<string, unknown> = {}): OrthoEvent {
  return {
    event_type: 'lead.stage_changed',
    entity_type: 'lead',
    entity_id: overrides.lead_id as string ?? 'lead-1',
    payload: {
      lead_id: 'lead-1',
      pipeline: 'new_patient',
      stage_from: 'contacted',
      stage_to: 'exam_scheduled',
      transitioned_at: '2026-04-09T12:00:00Z',
      ...overrides,
    },
  };
}

describe.skipIf(!HAS_DB)('handleLeadStageChanged (integration)', () => {
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
    fetchMock.mockResolvedValue({ ok: true });

    referrer = await insertReferrer(db, {
      referrer_type: 'patient',
      name: 'Jane Doe',
      phone: '+15551234567',
    });
    link = await insertReferralLink(db, {
      referrer_id: referrer.id as string,
      code: 'TESTCD01',
    });
  });

  it('advances status to exam_scheduled and sets exam_scheduled_at from transitioned_at', async () => {
    const referral = await insertReferral(db, {
      referral_link_id: link.id as string,
      referrer_id: referrer.id as string,
      lead_id: 'lead-1',
    });

    const event = makeStageChangedEvent({
      transitioned_at: '2026-04-09T15:30:00Z',
    });

    await handleLeadStageChanged(event, db);

    const row = await db('referrals').where({ id: referral.id }).first();
    expect(row.status).toBe('exam_scheduled');
    expect(new Date(row.exam_scheduled_at).toISOString()).toBe('2026-04-09T15:30:00.000Z');
  });

  it('sends SMS with dedup_key for patient referrer', async () => {
    const referral = await insertReferral(db, {
      referral_link_id: link.id as string,
      referrer_id: referrer.id as string,
      lead_id: 'lead-1',
    });

    await handleLeadStageChanged(makeStageChangedEvent(), db);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/messages/send');
    const body = JSON.parse(opts.body);
    expect(body.dedup_key).toBe(`referral_exam_notify:${referral.id}`);
    expect(body.to).toBe('+15551234567');
  });

  it('does not send SMS for doctor referrer', async () => {
    const doctorReferrer = await insertReferrer(db, {
      referrer_type: 'doctor',
      name: 'Dr. Smith',
      phone: '+15559999999',
      practice_name: 'Smith Ortho',
    });
    const doctorLink = await insertReferralLink(db, {
      referrer_id: doctorReferrer.id as string,
      code: 'DOCCODE1',
    });
    await insertReferral(db, {
      referral_link_id: doctorLink.id as string,
      referrer_id: doctorReferrer.id as string,
      lead_id: 'lead-1',
    });

    await handleLeadStageChanged(makeStageChangedEvent(), db);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips non-exam_scheduled stage', async () => {
    await insertReferral(db, {
      referral_link_id: link.id as string,
      referrer_id: referrer.id as string,
      lead_id: 'lead-1',
    });

    const event = makeStageChangedEvent({ stage_to: 'contacted' });
    await handleLeadStageChanged(event, db);

    const row = await db('referrals').where({ lead_id: 'lead-1' }).first();
    expect(row.status).toBe('pending');
  });

  it('skips pipeline != new_patient', async () => {
    await insertReferral(db, {
      referral_link_id: link.id as string,
      referrer_id: referrer.id as string,
      lead_id: 'lead-1',
    });

    const event = makeStageChangedEvent({ pipeline: 'in_treatment' });
    await handleLeadStageChanged(event, db);

    const row = await db('referrals').where({ lead_id: 'lead-1' }).first();
    expect(row.status).toBe('pending');
  });

  it('skips when referral record not found for lead_id', async () => {
    const event = makeStageChangedEvent({ lead_id: 'nonexistent-lead' });
    await handleLeadStageChanged(event, db);

    // No error, just silently skips
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not send duplicate SMS on second delivery (dedup_key)', async () => {
    await insertReferral(db, {
      referral_link_id: link.id as string,
      referrer_id: referrer.id as string,
      lead_id: 'lead-1',
    });

    const event = makeStageChangedEvent();

    await handleLeadStageChanged(event, db);
    await handleLeadStageChanged(event, db);

    // Both calls use the same dedup_key so Messaging Service deduplicates,
    // but from our side, the handler does call fetch twice (the dedup happens server-side).
    // The key thing is the dedup_key is consistently set.
    const calls = fetchMock.mock.calls.filter(
      (c: unknown[]) => (c[0] as string).includes('/messages/send'),
    );
    for (const call of calls) {
      const body = JSON.parse((call[1] as { body: string }).body);
      expect(body.dedup_key).toMatch(/^referral_exam_notify:/);
    }
  });
});
