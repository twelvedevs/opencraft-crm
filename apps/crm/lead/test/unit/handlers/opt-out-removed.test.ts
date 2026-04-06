import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/repositories/lead-repository.js', () => ({
  findByPhone: vi.fn(),
}));

vi.mock('../../../src/repositories/activity-repository.js', () => ({
  insertActivity: vi.fn(),
  findLastInboundAt: vi.fn(),
}));

vi.mock('../../../src/scoring/score-calculator.js', () => ({
  calculateScore: vi.fn(),
}));

vi.mock('../../../src/scoring/contact-status.js', () => ({
  removeOptOut: vi.fn(),
}));

import type { Knex } from 'knex';
import type { OrthoEvent } from '@ortho/event-bus';
import { handleOptOutRemoved } from '../../../src/workers/handlers/opt-out-removed.js';
import * as leadRepository from '../../../src/repositories/lead-repository.js';
import * as activityRepository from '../../../src/repositories/activity-repository.js';
import { calculateScore } from '../../../src/scoring/score-calculator.js';
import { removeOptOut } from '../../../src/scoring/contact-status.js';

const makeLead = (overrides: Record<string, unknown> = {}) => ({
  id: 'lead-1',
  location_id: 'loc-1',
  first_name: 'Jane',
  last_name: 'Doe',
  phone: '+12125551234',
  email: 'jane@example.com',
  treatment_interest: null,
  date_of_birth: null,
  channel: 'website_form',
  contact_status: 'sms_opted_out',
  current_pipeline: 'new_patient',
  current_stage: 'new_lead',
  last_activity_at: null,
  score: 30,
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

const makeEvent = (overrides: Record<string, unknown> = {}): OrthoEvent => ({
  event_id: 'evt-optr-001',
  event_type: 'opt_out.removed',
  entity_type: 'lead',
  entity_id: '',
  timestamp: new Date().toISOString(),
  payload: {
    phone_number: '+12125551234',
    removed_at: '2026-04-06T12:00:00Z',
    ...overrides,
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

const createMockDb = () => {
  mockTrx = createMockTrx();
  const trxFn = vi.fn().mockImplementation(async (cb: (trx: Knex.Transaction) => Promise<unknown>) => {
    return cb(mockTrx);
  });
  return { transaction: trxFn } as unknown as Knex;
};

beforeEach(() => {
  vi.clearAllMocks();
  db = createMockDb();

  vi.mocked(leadRepository.findByPhone).mockResolvedValue([makeLead()]);
  vi.mocked(activityRepository.findLastInboundAt).mockResolvedValue(null);
  vi.mocked(activityRepository.insertActivity).mockResolvedValue('activity-1');
  vi.mocked(removeOptOut).mockReturnValue('active');
  vi.mocked(calculateScore).mockReturnValue(50);
});

describe('handleOptOutRemoved', () => {
  it('transitions sms_opted_out to active', async () => {
    vi.mocked(removeOptOut).mockReturnValue('active');

    await handleOptOutRemoved(makeEvent(), db);

    expect(removeOptOut).toHaveBeenCalledWith('sms_opted_out');
    expect((mockTrx as unknown as Record<string, unknown>).raw).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE crm_leads.leads SET contact_status'),
      ['active', 'lead-1'],
    );
  });

  it('transitions fully_unreachable to email_invalid', async () => {
    vi.mocked(leadRepository.findByPhone).mockResolvedValue([makeLead({ contact_status: 'fully_unreachable' })]);
    vi.mocked(removeOptOut).mockReturnValue('email_invalid');

    await handleOptOutRemoved(makeEvent(), db);

    expect(removeOptOut).toHaveBeenCalledWith('fully_unreachable');
    expect((mockTrx as unknown as Record<string, unknown>).raw).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE crm_leads.leads SET contact_status'),
      ['email_invalid', 'lead-1'],
    );
  });

  it('recalculates score and inserts activity', async () => {
    vi.mocked(calculateScore).mockReturnValue(60);

    await handleOptOutRemoved(makeEvent(), db);

    expect(calculateScore).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'opt_out.removed',
      }),
    );
    expect((mockTrx as unknown as Record<string, unknown>).raw).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE crm_leads.leads SET score'),
      [60, 'lead-1'],
    );
    expect(activityRepository.insertActivity).toHaveBeenCalledWith(
      mockTrx,
      expect.objectContaining({
        lead_id: 'lead-1',
        event_type: 'opt_out.removed',
        actor_type: 'system',
      }),
    );
  });
});
