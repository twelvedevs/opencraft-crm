import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/repositories/lead-repository.js', () => ({
  findById: vi.fn(),
}));

vi.mock('../../src/repositories/activity-repository.js', () => ({
  insertActivity: vi.fn(),
}));

vi.mock('../../src/events/publisher.js', () => ({
  publishLeadMerged: vi.fn(),
}));

vi.mock('../../src/env.js', () => ({
  env: {
    PIPELINE_ENGINE_URL: 'http://pipeline:3000',
    SERVICE_AUTH_TOKEN: 'test-token',
  },
}));

import type { Knex } from 'knex';
import type { EventBus } from '@ortho/event-bus';
import { mergeLeads, MergeError } from '../../src/services/merge-service.js';
import * as leadRepository from '../../src/repositories/lead-repository.js';
import * as activityRepository from '../../src/repositories/activity-repository.js';
import { publishLeadMerged } from '../../src/events/publisher.js';

const eventBus = { publish: vi.fn(), stop: vi.fn() } as unknown as EventBus;

const makeLead = (overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-1111-1111-111111111111',
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
  duplicate_status: 'flagged',
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

const survivingLead = makeLead({ id: 'surviving-id', current_stage: 'new_lead' });
const mergeLead = makeLead({ id: 'merge-id', current_stage: 'contacted' });

// Mock transaction helper — trx must be callable (Knex transactions are both functions and objects)
const createMockTrx = () => {
  const whereReturn = {
    update: vi.fn().mockResolvedValue(1),
  };
  const insertReturn = {
    insert: vi.fn().mockResolvedValue([1]),
  };

  // trx(tableName) returns a query builder
  const trxCallable = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue(whereReturn),
    insert: vi.fn().mockResolvedValue([1]),
  });

  // Attach raw and fn as properties
  trxCallable.raw = vi.fn().mockResolvedValue(undefined);
  trxCallable.fn = { now: () => 'now()' };

  return trxCallable as unknown as Knex.Transaction;
};

let mockTrx: Knex.Transaction;

const createMockDb = () => {
  mockTrx = createMockTrx();
  const trxFn = vi.fn().mockImplementation(async (cb: (trx: Knex.Transaction) => Promise<void>) => {
    await cb(mockTrx);
  });

  const db = { transaction: trxFn } as unknown as Knex;
  return db;
};

let db: Knex;

beforeEach(() => {
  vi.clearAllMocks();
  db = createMockDb();

  // Default: both leads found, not merged
  vi.mocked(leadRepository.findById)
    .mockResolvedValueOnce(survivingLead) // first call — surviving
    .mockResolvedValueOnce(mergeLead)     // second call — merge
    .mockResolvedValueOnce(survivingLead); // third call — re-fetch after merge

  // Default: mock global fetch to succeed
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});

describe('mergeLeads', () => {
  describe('Pipeline Engine call', () => {
    it('calls Pipeline Engine when winningStage !== current_stage', async () => {
      await mergeLeads(db, eventBus, 'surviving-id', 'merge-id', 'contacted', 'user-1', ['loc-1']);

      expect(fetch).toHaveBeenCalledWith(
        'http://pipeline:3000/pipeline/leads/surviving-id/transition',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ stage: 'contacted', reason: 'merge' }),
        }),
      );
    });

    it('does NOT call Pipeline Engine when winningStage === current_stage', async () => {
      await mergeLeads(db, eventBus, 'surviving-id', 'merge-id', 'new_lead', 'user-1', ['loc-1']);

      expect(fetch).not.toHaveBeenCalled();
    });

    it('throws 503 MergeError when Pipeline Engine returns non-ok response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

      try {
        await mergeLeads(db, eventBus, 'surviving-id', 'merge-id', 'contacted', 'user-1', ['loc-1']);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MergeError);
        expect((err as MergeError).statusCode).toBe(503);
      }

      // Verify no DB writes were executed
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('throws 503 MergeError when Pipeline Engine fetch throws (timeout/network)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('AbortError: timeout')));

      try {
        await mergeLeads(db, eventBus, 'surviving-id', 'merge-id', 'contacted', 'user-1', ['loc-1']);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MergeError);
        expect((err as MergeError).statusCode).toBe(503);
      }
    });
  });

  describe('happy path', () => {
    it('executes all steps in transaction and publishes event after commit', async () => {
      await mergeLeads(db, eventBus, 'surviving-id', 'merge-id', 'new_lead', 'user-1', ['loc-1']);

      // Transaction was called
      expect(db.transaction).toHaveBeenCalled();

      // Step 3 — copy activities (raw SQL)
      expect(mockTrx.raw).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO crm_leads.lead_activities'),
        ['surviving-id', 'merge-id'],
      );

      // Step 4 — copy tags (raw SQL)
      expect(mockTrx.raw).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO crm_leads.lead_tags'),
        ['surviving-id', 'merge-id'],
      );

      // Step 7 — insert activity
      expect(activityRepository.insertActivity).toHaveBeenCalledWith(
        mockTrx,
        expect.objectContaining({
          lead_id: 'surviving-id',
          event_type: 'lead.merged',
          actor_type: 'staff',
          actor_id: 'user-1',
          payload: { merged_lead_id: 'merge-id' },
        }),
      );

      // publishLeadMerged called after transaction
      expect(publishLeadMerged).toHaveBeenCalledWith(eventBus, {
        surviving_lead_id: 'surviving-id',
        merged_lead_id: 'merge-id',
        location_id: 'loc-1',
      });
    });
  });

  describe('validation errors', () => {
    it('throws 404 when surviving lead not found', async () => {
      vi.mocked(leadRepository.findById).mockReset();
      vi.mocked(leadRepository.findById).mockResolvedValueOnce(null);

      try {
        await mergeLeads(db, eventBus, 'missing-id', 'merge-id', 'new_lead', 'user-1', ['loc-1']);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MergeError);
        expect((err as MergeError).statusCode).toBe(404);
      }
    });

    it('throws 404 when merge lead not found', async () => {
      vi.mocked(leadRepository.findById).mockReset();
      vi.mocked(leadRepository.findById)
        .mockResolvedValueOnce(survivingLead)
        .mockResolvedValueOnce(null);

      try {
        await mergeLeads(db, eventBus, 'surviving-id', 'missing-id', 'new_lead', 'user-1', ['loc-1']);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MergeError);
        expect((err as MergeError).statusCode).toBe(404);
      }
    });

    it('throws 400 when merge lead already merged (merged_into_id set)', async () => {
      vi.mocked(leadRepository.findById).mockReset();
      vi.mocked(leadRepository.findById)
        .mockResolvedValueOnce(survivingLead)
        .mockResolvedValueOnce(makeLead({ id: 'merge-id', merged_into_id: 'some-other-id' }));

      try {
        await mergeLeads(db, eventBus, 'surviving-id', 'merge-id', 'new_lead', 'user-1', ['loc-1']);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MergeError);
        expect((err as MergeError).statusCode).toBe(400);
        expect((err as MergeError).message).toBe('lead already merged');
      }
    });

    it('throws 400 when surviving lead already merged', async () => {
      vi.mocked(leadRepository.findById).mockReset();
      vi.mocked(leadRepository.findById)
        .mockResolvedValueOnce(makeLead({ id: 'surviving-id', merged_into_id: 'some-other-id' }))
        .mockResolvedValueOnce(mergeLead);

      try {
        await mergeLeads(db, eventBus, 'surviving-id', 'merge-id', 'new_lead', 'user-1', ['loc-1']);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MergeError);
        expect((err as MergeError).statusCode).toBe(400);
      }
    });

    it('throws 403 when neither lead location in userLocations', async () => {
      try {
        await mergeLeads(db, eventBus, 'surviving-id', 'merge-id', 'new_lead', 'user-1', ['loc-other']);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MergeError);
        expect((err as MergeError).statusCode).toBe(403);
        expect((err as MergeError).message).toBe('access denied');
      }
    });

    it('bypasses location check when userLocations is empty (super_admin)', async () => {
      await mergeLeads(db, eventBus, 'surviving-id', 'merge-id', 'new_lead', 'user-1', []);

      // Should succeed — transaction called
      expect(db.transaction).toHaveBeenCalled();
    });
  });
});

