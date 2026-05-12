import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/repositories/lead-repository.js', () => ({
  findById: vi.fn(),
}));

vi.mock('../../../src/repositories/activity-repository.js', () => ({
  insertActivity: vi.fn(),
}));

vi.mock('../../../src/scoring/score-calculator.js', () => ({
  calculateScore: vi.fn(),
}));

import type { Knex } from 'knex';
import type { OrthoEvent } from '@ortho/event-bus';
import { handleLeadConverted } from '../../../src/workers/handlers/lead-converted.js';
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
  current_stage: 'contract_signed',
  last_activity_at: null,
  score: 40,
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
  event_id: 'evt-converted-1',
  event_type: 'lead.converted',
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
  vi.mocked(activityRepository.insertActivity).mockResolvedValue('activity-1');
});

describe('handleLeadConverted', () => {
  it('returns early when lead not found', async () => {
    vi.mocked(leadRepository.findById).mockResolvedValue(null);

    await handleLeadConverted(makeEvent(), db);

    expect(db.transaction).not.toHaveBeenCalled();
    expect(activityRepository.insertActivity).not.toHaveBeenCalled();
  });

  it('inserts activity BEFORE state update (verify call order)', async () => {
    const callOrder: string[] = [];
    vi.mocked(activityRepository.insertActivity).mockImplementation(async () => {
      callOrder.push('insertActivity');
      return 'a-1';
    });
    const rawMock = vi.fn().mockImplementation(async () => {
      callOrder.push('updateState');
    });
    (mockTrx as unknown as Record<string, unknown>).raw = rawMock;

    await handleLeadConverted(makeEvent(), db);

    expect(callOrder).toEqual(['insertActivity', 'updateState']);
  });

  it('sets current_pipeline to none and current_stage to NULL', async () => {
    await handleLeadConverted(makeEvent(), db);

    expect((mockTrx as unknown as Record<string, unknown>).raw).toHaveBeenCalledWith(
      expect.stringContaining("current_pipeline = 'none'"),
      ['lead-1'],
    );
    expect((mockTrx as unknown as Record<string, unknown>).raw).toHaveBeenCalledWith(
      expect.stringContaining('current_stage = NULL'),
      expect.anything(),
    );
  });

  it('does NOT call calculateScore (score not recalculated on conversion)', async () => {
    await handleLeadConverted(makeEvent(), db);

    expect(calculateScore).not.toHaveBeenCalled();
  });

  it('inserts activity with correct fields', async () => {
    await handleLeadConverted(makeEvent(), db);

    expect(activityRepository.insertActivity).toHaveBeenCalledWith(
      mockTrx,
      expect.objectContaining({
        lead_id: 'lead-1',
        event_type: 'lead.converted',
        actor_type: 'system',
        actor_id: null,
      }),
    );
  });
});
