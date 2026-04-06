import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/repositories/lead-repository.js', () => ({
  findByEmail: vi.fn(),
}));

vi.mock('../../../src/repositories/activity-repository.js', () => ({
  insertActivity: vi.fn(),
  findLastInboundAt: vi.fn(),
}));

vi.mock('../../../src/scoring/score-calculator.js', () => ({
  calculateScore: vi.fn(),
}));

vi.mock('../../../src/scoring/contact-status.js', () => ({
  applyHardBounce: vi.fn(),
}));

import type { Knex } from 'knex';
import type { OrthoEvent } from '@ortho/event-bus';
import { handleEmailBounced } from '../../../src/workers/handlers/email-bounced.js';
import * as leadRepository from '../../../src/repositories/lead-repository.js';
import * as activityRepository from '../../../src/repositories/activity-repository.js';
import { calculateScore } from '../../../src/scoring/score-calculator.js';
import { applyHardBounce } from '../../../src/scoring/contact-status.js';

const makeLead = (overrides: Record<string, unknown> = {}) => ({
  id: 'lead-1',
  location_id: 'loc-1',
  first_name: 'Jane',
  last_name: 'Doe',
  phone: '+15551234567',
  email: 'jane@example.com',
  treatment_interest: null,
  date_of_birth: null,
  channel: 'website_form',
  contact_status: 'active',
  current_pipeline: 'new_patient',
  current_stage: 'new_lead',
  last_activity_at: null,
  score: 50,
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
  event_id: 'evt-bounce-001',
  event_type: 'email.bounced',
  entity_type: 'email',
  entity_id: '',
  timestamp: new Date().toISOString(),
  payload: {
    to_address: 'jane@example.com',
    bounce_type: 'hard',
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

  vi.mocked(leadRepository.findByEmail).mockResolvedValue([makeLead()]);
  vi.mocked(activityRepository.findLastInboundAt).mockResolvedValue(null);
  vi.mocked(activityRepository.insertActivity).mockResolvedValue('activity-1');
  vi.mocked(applyHardBounce).mockReturnValue('email_invalid');
  vi.mocked(calculateScore).mockReturnValue(20);
});

describe('handleEmailBounced', () => {
  it('returns early for soft bounce with no DB writes', async () => {
    const event = makeEvent({ bounce_type: 'soft' });

    await handleEmailBounced(event, db);

    expect(leadRepository.findByEmail).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(activityRepository.insertActivity).not.toHaveBeenCalled();
  });

  it('returns early when no lead found for hard bounce', async () => {
    vi.mocked(leadRepository.findByEmail).mockResolvedValue([]);

    await handleEmailBounced(makeEvent(), db);

    expect(db.transaction).not.toHaveBeenCalled();
    expect(activityRepository.insertActivity).not.toHaveBeenCalled();
  });

  it('sets contact_status to email_invalid for active lead on hard bounce', async () => {
    vi.mocked(applyHardBounce).mockReturnValue('email_invalid');

    await handleEmailBounced(makeEvent(), db);

    expect(applyHardBounce).toHaveBeenCalledWith('active');
    expect((mockTrx as unknown as Record<string, unknown>).raw).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE crm_leads.leads SET contact_status'),
      ['email_invalid', 'lead-1'],
    );
  });

  it('sets contact_status to fully_unreachable for sms_opted_out lead on hard bounce', async () => {
    vi.mocked(leadRepository.findByEmail).mockResolvedValue([makeLead({ contact_status: 'sms_opted_out' })]);
    vi.mocked(applyHardBounce).mockReturnValue('fully_unreachable');

    await handleEmailBounced(makeEvent(), db);

    expect(applyHardBounce).toHaveBeenCalledWith('sms_opted_out');
    expect((mockTrx as unknown as Record<string, unknown>).raw).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE crm_leads.leads SET contact_status'),
      ['fully_unreachable', 'lead-1'],
    );
  });

  it('recalculates score and inserts activity for hard bounce', async () => {
    vi.mocked(calculateScore).mockReturnValue(15);

    await handleEmailBounced(makeEvent(), db);

    expect(calculateScore).toHaveBeenCalledWith(
      expect.objectContaining({
        lead: expect.objectContaining({ contact_status: 'email_invalid' }),
        eventType: 'email.bounced',
      }),
    );
    expect((mockTrx as unknown as Record<string, unknown>).raw).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE crm_leads.leads SET score'),
      [15, 'lead-1'],
    );
    expect(activityRepository.insertActivity).toHaveBeenCalledWith(
      mockTrx,
      expect.objectContaining({
        lead_id: 'lead-1',
        event_type: 'email.bounced',
        actor_type: 'system',
      }),
    );
  });
});
