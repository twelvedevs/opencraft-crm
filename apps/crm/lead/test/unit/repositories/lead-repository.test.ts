import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Knex } from 'knex';

// Mock env before importing repository
vi.mock('../../../src/env.js', () => ({
  env: { SEARCH_SIMILARITY_THRESHOLD: 0.2 },
}));

import {
  createLead,
  findById,
  findByPhone,
  findByEmail,
  findByAdPlatformLeadId,
  updateLead,
  archiveLead,
  listLeads,
  findByPhones,
  findByEmails,
  findByIds,
} from '../../../src/repositories/lead-repository.js';
import type { CreateLeadData, UpdateableLeadFields } from '../../../src/repositories/lead-repository.js';

const fakeLead = {
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
  current_pipeline: 'none',
  current_stage: null,
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
};

function makeQueryBuilder(overrides: Record<string, unknown> = {}) {
  const qb: Record<string, unknown> = {
    insert: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([fakeLead]),
    where: vi.fn().mockReturnThis(),
    whereIn: vi.fn().mockReturnThis(),
    whereNull: vi.fn().mockReturnThis(),
    whereNot: vi.fn().mockReturnThis(),
    whereRaw: vi.fn().mockReturnThis(),
    whereNotNull: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(fakeLead),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockResolvedValue(1),
    select: vi.fn().mockReturnThis(),
    join: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    orderByRaw: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([fakeLead]),
    then: vi.fn(),
    ...overrides,
  };
  return qb;
}

function makeDb(qb: Record<string, unknown>): Knex {
  const db = vi.fn().mockReturnValue(qb) as unknown as Knex;
  (db as unknown as Record<string, unknown>)['fn'] = {
    now: vi.fn().mockReturnValue('NOW()'),
  };
  return db;
}

describe('lead-repository', () => {
  describe('createLead', () => {
    it('inserts correct fields and returns inserted row', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);

      const data = {
        location_id: 'loc-1',
        first_name: 'John',
        last_name: 'Doe',
        phone: '+15551234567',
        email: null,
        treatment_interest: null,
        date_of_birth: null,
        channel: 'website_form',
        contact_status: 'active',
        current_pipeline: 'none',
        current_stage: null,
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
      } as CreateLeadData;

      const result = await createLead(db, data);

      expect(db).toHaveBeenCalledWith('crm_leads.leads');
      expect(qb.insert).toHaveBeenCalledWith(data);
      expect(qb.returning).toHaveBeenCalledWith('*');
      expect(result).toEqual(fakeLead);
    });
  });

  describe('findById', () => {
    it('returns row when found', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);

      const result = await findById(db, 'some-id');

      expect(db).toHaveBeenCalledWith('crm_leads.leads');
      expect(qb.where).toHaveBeenCalledWith({ id: 'some-id' });
      expect(qb.first).toHaveBeenCalled();
      expect(result).toEqual(fakeLead);
    });

    it('returns null when not found', async () => {
      const qb = makeQueryBuilder({
        first: vi.fn().mockResolvedValue(undefined),
      });
      const db = makeDb(qb);

      const result = await findById(db, 'missing-id');

      expect(result).toBeNull();
    });
  });

  describe('findByPhone', () => {
    it('filters by phone + archived/merged conditions', async () => {
      const qb = makeQueryBuilder({
        then: vi.fn((_cb: (v: unknown) => unknown) => Promise.resolve(_cb([fakeLead]))),
      });
      const db = makeDb(qb);

      const result = await findByPhone(db, '+15551234567');

      expect(qb.where).toHaveBeenCalledWith({ phone: '+15551234567' });
      expect(qb.whereNull).toHaveBeenCalledWith('archived_at');
      expect(qb.whereNull).toHaveBeenCalledWith('merged_into_id');
      expect(result).toEqual([fakeLead]);
    });

    it('adds excludeId filter when provided', async () => {
      const qb = makeQueryBuilder({
        then: vi.fn((_cb: (v: unknown) => unknown) => Promise.resolve(_cb([]))),
      });
      const db = makeDb(qb);

      await findByPhone(db, '+15551234567', 'exclude-me');

      expect(qb.whereNot).toHaveBeenCalledWith({ id: 'exclude-me' });
    });
  });

  describe('findByEmail', () => {
    it('does case-insensitive match', async () => {
      const qb = makeQueryBuilder({
        then: vi.fn((_cb: (v: unknown) => unknown) => Promise.resolve(_cb([fakeLead]))),
      });
      const db = makeDb(qb);

      const result = await findByEmail(db, 'John@Example.com');

      expect(qb.whereRaw).toHaveBeenCalledWith('LOWER(email) = LOWER(?)', ['John@Example.com']);
      expect(qb.whereNull).toHaveBeenCalledWith('archived_at');
      expect(qb.whereNull).toHaveBeenCalledWith('merged_into_id');
      expect(result).toEqual([fakeLead]);
    });
  });

  describe('findByAdPlatformLeadId', () => {
    it('returns first match', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);

      const result = await findByAdPlatformLeadId(db, 'ad-123');

      expect(qb.where).toHaveBeenCalledWith({ ad_platform_lead_id: 'ad-123' });
      expect(result).toEqual(fakeLead);
    });

    it('returns null when not found', async () => {
      const qb = makeQueryBuilder({
        first: vi.fn().mockResolvedValue(undefined),
      });
      const db = makeDb(qb);

      const result = await findByAdPlatformLeadId(db, 'nope');

      expect(result).toBeNull();
    });
  });

  describe('updateLead', () => {
    it('sets updated_at and returns updated row', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);
      const fields: Partial<UpdateableLeadFields> = { first_name: 'Jane' };

      const result = await updateLead(db, 'some-id', fields);

      expect(qb.where).toHaveBeenCalledWith({ id: 'some-id' });
      expect(qb.update).toHaveBeenCalledWith({ first_name: 'Jane', updated_at: 'NOW()' });
      expect(qb.returning).toHaveBeenCalledWith('*');
      expect(result).toEqual(fakeLead);
    });
  });

  describe('archiveLead', () => {
    it('sets archived_at and updated_at', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);

      const result = await archiveLead(db, 'some-id');

      expect(qb.where).toHaveBeenCalledWith({ id: 'some-id' });
      expect(qb.update).toHaveBeenCalledWith({
        archived_at: 'NOW()',
        updated_at: 'NOW()',
      });
      expect(qb.returning).toHaveBeenCalledWith('*');
      expect(result).toEqual(fakeLead);
    });
  });

  describe('listLeads', () => {
    it('applies location filter when locationIds non-empty', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);

      await listLeads(db, { locationIds: ['loc-1', 'loc-2'] });

      expect(qb.whereIn).toHaveBeenCalledWith('crm_leads.leads.location_id', ['loc-1', 'loc-2']);
    });

    it('omits location filter when locationIds empty', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);

      await listLeads(db, { locationIds: [] });

      // whereIn should not have been called with location_id
      const whereInCalls = (qb.whereIn as ReturnType<typeof vi.fn>).mock.calls;
      const locationCalls = whereInCalls.filter(
        (c: unknown[]) => c[0] === 'crm_leads.leads.location_id',
      );
      expect(locationCalls).toHaveLength(0);
    });

    it('applies pipeline filter', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);

      await listLeads(db, { pipeline: 'new_patient' });

      expect(qb.where).toHaveBeenCalledWith('crm_leads.leads.current_pipeline', 'new_patient');
    });

    it('filters by archived_at IS NULL by default', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);

      await listLeads(db, {});

      expect(qb.whereNull).toHaveBeenCalledWith('crm_leads.leads.archived_at');
    });

    it('omits archived_at filter when includeArchived is true', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);

      await listLeads(db, { includeArchived: true });

      const whereNullCalls = (qb.whereNull as ReturnType<typeof vi.fn>).mock.calls;
      const archivedCalls = whereNullCalls.filter(
        (c: unknown[]) => c[0] === 'crm_leads.leads.archived_at',
      );
      expect(archivedCalls).toHaveLength(0);
    });

    it('always filters merged_into_id IS NULL', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);

      await listLeads(db, {});

      expect(qb.whereNull).toHaveBeenCalledWith('crm_leads.leads.merged_into_id');
    });

    it('returns nextCursor when more rows than limit', async () => {
      const lead1 = { ...fakeLead, id: 'id-1', score: 10 };
      const lead2 = { ...fakeLead, id: 'id-2', score: 5 };
      const extraLead = { ...fakeLead, id: 'id-3', score: 1 };

      const qb = makeQueryBuilder({
        limit: vi.fn().mockResolvedValue([lead1, lead2, extraLead]),
      });
      const db = makeDb(qb);

      const result = await listLeads(db, { limit: 2 });

      expect(result.leads).toHaveLength(2);
      expect(result.nextCursor).not.toBeNull();
    });

    it('returns null nextCursor when rows equal to limit', async () => {
      const qb = makeQueryBuilder({
        limit: vi.fn().mockResolvedValue([fakeLead]),
      });
      const db = makeDb(qb);

      const result = await listLeads(db, { limit: 1 });

      expect(result.leads).toHaveLength(1);
      expect(result.nextCursor).toBeNull();
    });
  });

  describe('cursor encoding/decoding', () => {
    it('round-trips correctly', async () => {
      const lead1 = { ...fakeLead, id: 'id-1', score: 42 };
      const lead2 = { ...fakeLead, id: 'id-2', score: 10 };
      const extraLead = { ...fakeLead, id: 'id-3', score: 5 };

      const qb = makeQueryBuilder({
        limit: vi.fn().mockResolvedValue([lead1, lead2, extraLead]),
      });
      const db = makeDb(qb);

      const result = await listLeads(db, { limit: 2, sort: 'score' });

      expect(result.nextCursor).not.toBeNull();

      // Decode the cursor and verify values
      const decoded = JSON.parse(Buffer.from(result.nextCursor!, 'base64').toString('utf-8'));
      expect(decoded.lastSeenId).toBe('id-2');
      expect(decoded.lastSeenSortValue).toBe(10);
    });
  });

  describe('findByPhones', () => {
    it('applies ANY($phones) filter', async () => {
      const qb = makeQueryBuilder({
        then: vi.fn((_cb: (v: unknown) => unknown) => Promise.resolve(_cb([fakeLead]))),
      });
      const db = makeDb(qb);

      const result = await findByPhones(db, ['+15551234567'], ['loc-1']);

      expect(qb.whereIn).toHaveBeenCalledWith('phone', ['+15551234567']);
      expect(qb.whereNull).toHaveBeenCalledWith('archived_at');
      expect(qb.whereNull).toHaveBeenCalledWith('merged_into_id');
      expect(qb.whereIn).toHaveBeenCalledWith('location_id', ['loc-1']);
      expect(result).toEqual([fakeLead]);
    });

    it('skips location filter when locationIds empty', async () => {
      const qb = makeQueryBuilder({
        then: vi.fn((_cb: (v: unknown) => unknown) => Promise.resolve(_cb([]))),
      });
      const db = makeDb(qb);

      await findByPhones(db, ['+15551234567'], []);

      const whereInCalls = (qb.whereIn as ReturnType<typeof vi.fn>).mock.calls;
      const locationCalls = whereInCalls.filter((c: unknown[]) => c[0] === 'location_id');
      expect(locationCalls).toHaveLength(0);
    });
  });

  describe('findByEmails', () => {
    it('lowercases emails for comparison', async () => {
      const qb = makeQueryBuilder({
        then: vi.fn((_cb: (v: unknown) => unknown) => Promise.resolve(_cb([fakeLead]))),
      });
      const db = makeDb(qb);

      await findByEmails(db, ['John@Example.COM'], ['loc-1']);

      expect(qb.whereRaw).toHaveBeenCalledWith('LOWER(email) = ANY(?)', [['john@example.com']]);
    });
  });

  describe('findByIds', () => {
    it('applies ANY($ids) filter with location scoping', async () => {
      const qb = makeQueryBuilder({
        then: vi.fn((_cb: (v: unknown) => unknown) => Promise.resolve(_cb([fakeLead]))),
      });
      const db = makeDb(qb);

      const result = await findByIds(db, ['id-1', 'id-2'], ['loc-1']);

      expect(qb.whereIn).toHaveBeenCalledWith('id', ['id-1', 'id-2']);
      expect(qb.whereIn).toHaveBeenCalledWith('location_id', ['loc-1']);
      expect(result).toEqual([fakeLead]);
    });

    it('skips location filter when locationIds empty', async () => {
      const qb = makeQueryBuilder({
        then: vi.fn((_cb: (v: unknown) => unknown) => Promise.resolve(_cb([fakeLead]))),
      });
      const db = makeDb(qb);

      await findByIds(db, ['id-1'], []);

      const whereInCalls = (qb.whereIn as ReturnType<typeof vi.fn>).mock.calls;
      const locationCalls = whereInCalls.filter((c: unknown[]) => c[0] === 'location_id');
      expect(locationCalls).toHaveLength(0);
    });
  });
});
