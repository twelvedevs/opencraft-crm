import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/repositories/lead-repository.js', () => ({
  findById: vi.fn(),
}));

vi.mock('../../../src/repositories/activity-repository.js', () => ({
  insertActivity: vi.fn(),
}));

import type { Knex } from 'knex';
import type { OrthoEvent } from '@ortho/event-bus';
import { handleWorkflowTriggered } from '../../../src/workers/handlers/workflow-triggered.js';
import * as leadRepository from '../../../src/repositories/lead-repository.js';
import * as activityRepository from '../../../src/repositories/activity-repository.js';

const makeLead = () => ({
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
});

const makeEvent = (overrides: Record<string, unknown> = {}): OrthoEvent => ({
  event_id: 'evt-wf-001',
  event_type: 'workflow.triggered',
  entity_type: 'workflow',
  entity_id: 'lead-1',
  timestamp: new Date().toISOString(),
  payload: {
    entity_id: 'lead-1',
    entity_type: 'lead',
    workflow_id: 'wf-1',
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

  vi.mocked(leadRepository.findById).mockResolvedValue(makeLead());
  vi.mocked(activityRepository.insertActivity).mockResolvedValue('activity-1');
});

describe('handleWorkflowTriggered', () => {
  it('returns early silently when entity_type is not lead (no warn log)', async () => {
    const event = makeEvent({ entity_type: 'contact', entity_id: 'contact-1' });

    await handleWorkflowTriggered(event, db);

    expect(leadRepository.findById).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(activityRepository.insertActivity).not.toHaveBeenCalled();
  });

  it('warns and returns when entity_type is lead but lead not found', async () => {
    vi.mocked(leadRepository.findById).mockResolvedValue(null);

    await handleWorkflowTriggered(makeEvent(), db);

    expect(leadRepository.findById).toHaveBeenCalledWith(db, 'lead-1');
    expect(db.transaction).not.toHaveBeenCalled();
    expect(activityRepository.insertActivity).not.toHaveBeenCalled();
  });

  it('inserts activity on happy path', async () => {
    await handleWorkflowTriggered(makeEvent(), db);

    expect(activityRepository.insertActivity).toHaveBeenCalledWith(
      mockTrx,
      expect.objectContaining({
        lead_id: 'lead-1',
        event_type: 'workflow.triggered',
        actor_type: 'automation',
      }),
    );
  });
});
