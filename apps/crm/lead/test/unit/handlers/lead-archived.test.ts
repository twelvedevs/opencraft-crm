import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/repositories/lead-repository.js', () => ({
  findById: vi.fn(),
}));

vi.mock('../../../src/repositories/activity-repository.js', () => ({
  insertActivity: vi.fn(),
  findLastInboundAt: vi.fn(),
}));

vi.mock('../../../src/scoring/score-calculator.js', () => ({
  calculateScore: vi.fn(),
}));

import type { Knex } from 'knex';
import type { OrthoEvent } from '@ortho/event-bus';
import { handleLeadArchived } from '../../../src/workers/handlers/lead-archived.js';
import * as leadRepository from '../../../src/repositories/lead-repository.js';
import * as activityRepository from '../../../src/repositories/activity-repository.js';
import { calculateScore } from '../../../src/scoring/score-calculator.js';

const makeLead = (overrides: Record<string, unknown> = {}) => ({
  id: 'lead-1',
  location_id: 'loc-1',
  first_name: 'John',
  last_name: 'Doe',
  phone: '+15551234567',
  email: 'john@example.com',
  treatment_interest: null,
  date_of_birth: null,
  channel: 'website_form',
  contact_status: 'active',
  current_pipeline: 'new_patient',
  current_stage: 'new_lead',
  last_activity_at: null,
  score: 10,
  duplicate_status: 'none',
  duplicate_of_id: null,
  merged_into_id: null,
  archived_at: null,
  first_touch_source: null,
  first_touch_medium: null,
  first_touch_campaign: null,
  first_touch_ad: null,
  first_touch_keyword: null,
  first_touch_landing_page: null,
  first_touch_referring_url: null,
  first_touch_device: null,
  call_tracking_number: null,
  referrer_id: null,
  referrer_type: null,
  referral_code: null,
  ad_platform_lead_id: null,
  created_by_location: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

const makeEvent = (payloadOverrides: Record<string, unknown> = {}): OrthoEvent => ({
  event_id: 'evt-archived-1',
  event_type: 'lead.archived',
  entity_type: 'lead',
  entity_id: 'lead-1',
  timestamp: new Date().toISOString(),
  payload: {
    lead_id: 'lead-1',
    ...payloadOverrides,
  },
});

let mockTrx: Knex.Transaction;
let db: Knex;

const createMockTrx = () => {
  const trx = vi.fn() as unknown as Knex.Transaction;
  (trx as unknown as Record<string, unknown>).raw = vi.fn().mockResolvedValue(undefined);
  (trx as unknown as Record<string, unknown>).fn = { now: () => 'now()' };
  return trx;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockTrx = createMockTrx();
  const trxFn = vi.fn().mockImplementation(async (cb: (trx: Knex.Transaction) => Promise<unknown>) => {
    return cb(mockTrx);
  });
  db = { transaction: trxFn } as unknown as Knex;

  vi.mocked(leadRepository.findById).mockResolvedValue(makeLead());
  vi.mocked(activityRepository.findLastInboundAt).mockResolvedValue(null);
  vi.mocked(activityRepository.insertActivity).mockResolvedValue('activity-1');
  vi.mocked(calculateScore).mockReturnValue(0);
});

describe('handleLeadArchived', () => {
  it('returns early when lead not found', async () => {
    vi.mocked(leadRepository.findById).mockResolvedValue(null);

    await handleLeadArchived(makeEvent(), db);

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("clears current_pipeline to 'none' and current_stage to NULL", async () => {
    await handleLeadArchived(makeEvent(), db);

    expect((mockTrx as unknown as Record<string, unknown>).raw).toHaveBeenCalledWith(
      expect.stringContaining("current_pipeline = 'none'"),
      ['lead-1'],
    );
  });

  it('recalculates score with pipeline=none', async () => {
    await handleLeadArchived(makeEvent(), db);

    expect(calculateScore).toHaveBeenCalledWith(
      expect.objectContaining({
        lead: expect.objectContaining({
          current_pipeline: 'none',
          current_stage: null,
        }),
        eventType: 'lead.archived',
      }),
    );
  });

  it('updates score in DB', async () => {
    vi.mocked(calculateScore).mockReturnValue(5);

    await handleLeadArchived(makeEvent(), db);

    expect((mockTrx as unknown as Record<string, unknown>).raw).toHaveBeenCalledWith(
      expect.stringContaining('SET score'),
      [5, 'lead-1'],
    );
  });

  it('inserts activity with source_event_id=internal:lead.archived:{lead_id}', async () => {
    await handleLeadArchived(makeEvent(), db);

    expect(activityRepository.insertActivity).toHaveBeenCalledWith(
      mockTrx,
      expect.objectContaining({
        lead_id: 'lead-1',
        event_type: 'lead.archived',
        source_event_id: 'internal:lead.archived:lead-1',
        payload: {},
      }),
    );
  });

  it('does not throw when insertActivity returns null (ON CONFLICT skip)', async () => {
    vi.mocked(activityRepository.insertActivity).mockResolvedValue(null);

    await expect(handleLeadArchived(makeEvent(), db)).resolves.toBeUndefined();
  });
});
