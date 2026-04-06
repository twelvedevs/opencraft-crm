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
import { handleStageChanged } from '../../../src/workers/handlers/stage-changed.js';
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
  score: 0,
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
  event_id: 'evt-stage-1',
  event_type: 'lead.stage_changed',
  entity_type: 'lead',
  entity_id: 'lead-1',
  timestamp: new Date().toISOString(),
  payload: {
    lead_id: 'lead-1',
    pipeline: 'new_patient',
    stage_to: 'contacted',
    occurred_at: '2026-04-06T10:00:00Z',
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
  vi.mocked(calculateScore).mockReturnValue(42);
});

describe('handleStageChanged', () => {
  it('returns early when lead not found', async () => {
    vi.mocked(leadRepository.findById).mockResolvedValue(null);

    await handleStageChanged(makeEvent(), db);

    expect(db.transaction).not.toHaveBeenCalled();
    expect(activityRepository.insertActivity).not.toHaveBeenCalled();
  });

  it('updates current_pipeline and current_stage', async () => {
    await handleStageChanged(makeEvent(), db);

    expect((mockTrx as unknown as Record<string, unknown>).raw).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE crm_leads.leads SET current_pipeline'),
      ['new_patient', 'contacted', 'lead-1'],
    );
  });

  it('calls calculateScore with updated stage values', async () => {
    await handleStageChanged(makeEvent(), db);

    expect(calculateScore).toHaveBeenCalledWith(
      expect.objectContaining({
        lead: expect.objectContaining({
          current_pipeline: 'new_patient',
          current_stage: 'contacted',
        }),
        eventType: 'lead.stage_changed',
        lastInboundAt: null,
      }),
    );
  });

  it('updates score in DB', async () => {
    vi.mocked(calculateScore).mockReturnValue(75);

    await handleStageChanged(makeEvent(), db);

    expect((mockTrx as unknown as Record<string, unknown>).raw).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE crm_leads.leads SET score'),
      [75, 'lead-1'],
    );
  });

  it('inserts activity with correct event_type', async () => {
    await handleStageChanged(makeEvent(), db);

    expect(activityRepository.insertActivity).toHaveBeenCalledWith(
      mockTrx,
      expect.objectContaining({
        lead_id: 'lead-1',
        event_type: 'lead.stage_changed',
        actor_type: 'system',
        actor_id: null,
      }),
    );
  });

  it('executes all steps in correct order within transaction', async () => {
    const callOrder: string[] = [];
    const rawMock = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('current_pipeline')) callOrder.push('update_pipeline');
      if (sql.includes('score')) callOrder.push('update_score');
    });
    (mockTrx as unknown as Record<string, unknown>).raw = rawMock;
    vi.mocked(activityRepository.findLastInboundAt).mockImplementation(async () => {
      callOrder.push('findLastInboundAt');
      return null;
    });
    vi.mocked(calculateScore).mockImplementation(() => {
      callOrder.push('calculateScore');
      return 42;
    });
    vi.mocked(activityRepository.insertActivity).mockImplementation(async () => {
      callOrder.push('insertActivity');
      return 'a-1';
    });

    await handleStageChanged(makeEvent(), db);

    expect(callOrder).toEqual([
      'update_pipeline',
      'findLastInboundAt',
      'calculateScore',
      'update_score',
      'insertActivity',
    ]);
  });
});
