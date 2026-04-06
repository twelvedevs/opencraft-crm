import { describe, it, expect, vi } from 'vitest';
import type { Knex } from 'knex';
import {
  findTagsByLocation,
  findTagById,
  createTag,
  deleteTag,
  applyTagToLead,
  removeTagFromLead,
  findTagsByLeadId,
} from '../../../src/repositories/tag-repository.js';

const fakeTag = {
  id: 'tag-1',
  name: 'VIP',
  location_id: null,
  created_by: 'user-1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function makeQueryBuilder(overrides: Record<string, unknown> = {}) {
  const qb: Record<string, unknown> = {
    insert: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([fakeTag]),
    where: vi.fn().mockReturnThis(),
    whereNull: vi.fn().mockReturnThis(),
    orWhereNull: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(fakeTag),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockResolvedValue(1),
    select: vi.fn().mockReturnThis(),
    join: vi.fn().mockReturnThis(),
    onConflict: vi.fn().mockReturnThis(),
    ignore: vi.fn().mockReturnThis(),
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

describe('tag-repository', () => {
  describe('findTagsByLocation', () => {
    it('includes location + global tags when locationId provided', async () => {
      // findTagsByLocation uses a where callback, so we need to simulate the callback pattern
      const innerBuilder = {
        where: vi.fn().mockReturnThis(),
        orWhereNull: vi.fn().mockReturnThis(),
        whereNull: vi.fn().mockReturnThis(),
      };
      const qb = makeQueryBuilder({
        where: vi.fn().mockImplementation(function (this: unknown, cb: unknown) {
          if (typeof cb === 'function') {
            cb.call(innerBuilder);
          }
          return qb;
        }),
        then: vi.fn((_cb: (v: unknown) => unknown) => Promise.resolve(_cb([fakeTag]))),
      });
      const db = makeDb(qb);

      const result = await findTagsByLocation(db, 'loc-1');

      expect(db).toHaveBeenCalledWith('crm_leads.tags');
      expect(innerBuilder.where).toHaveBeenCalledWith({ location_id: 'loc-1' });
      expect(innerBuilder.orWhereNull).toHaveBeenCalledWith('location_id');
      expect(result).toEqual([fakeTag]);
    });

    it('returns only global tags when locationId is null', async () => {
      const innerBuilder = {
        where: vi.fn().mockReturnThis(),
        orWhereNull: vi.fn().mockReturnThis(),
        whereNull: vi.fn().mockReturnThis(),
      };
      const qb = makeQueryBuilder({
        where: vi.fn().mockImplementation(function (this: unknown, cb: unknown) {
          if (typeof cb === 'function') {
            cb.call(innerBuilder);
          }
          return qb;
        }),
        then: vi.fn((_cb: (v: unknown) => unknown) => Promise.resolve(_cb([fakeTag]))),
      });
      const db = makeDb(qb);

      await findTagsByLocation(db, null);

      expect(innerBuilder.whereNull).toHaveBeenCalledWith('location_id');
      expect(innerBuilder.where).not.toHaveBeenCalled();
    });
  });

  describe('findTagById', () => {
    it('returns tag when found', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);

      const result = await findTagById(db, 'tag-1');

      expect(qb.where).toHaveBeenCalledWith({ id: 'tag-1' });
      expect(result).toEqual(fakeTag);
    });

    it('returns null when not found', async () => {
      const qb = makeQueryBuilder({
        first: vi.fn().mockResolvedValue(undefined),
      });
      const db = makeDb(qb);

      const result = await findTagById(db, 'missing');

      expect(result).toBeNull();
    });
  });

  describe('createTag', () => {
    it('inserts correctly', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);
      const data = { name: 'VIP', location_id: null as string | null, created_by: 'user-1' };

      const result = await createTag(db, data);

      expect(db).toHaveBeenCalledWith('crm_leads.tags');
      expect(qb.insert).toHaveBeenCalledWith(data);
      expect(qb.returning).toHaveBeenCalledWith('*');
      expect(result).toEqual(fakeTag);
    });
  });

  describe('deleteTag', () => {
    it('deletes by id', async () => {
      const qb = makeQueryBuilder({
        delete: vi.fn().mockReturnThis(),
        then: vi.fn((_cb: (v: unknown) => unknown) => Promise.resolve(_cb(undefined))),
      });
      const db = makeDb(qb);

      await deleteTag(db, 'tag-1');

      expect(qb.where).toHaveBeenCalledWith({ id: 'tag-1' });
      expect(qb.delete).toHaveBeenCalled();
    });
  });

  describe('applyTagToLead', () => {
    it('uses ON CONFLICT DO NOTHING', async () => {
      const qb = makeQueryBuilder({
        then: vi.fn((_cb: (v: unknown) => unknown) => Promise.resolve(_cb(undefined))),
      });
      const db = makeDb(qb);

      await applyTagToLead(db, 'lead-1', 'tag-1', 'user-1');

      expect(db).toHaveBeenCalledWith('crm_leads.lead_tags');
      expect(qb.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          lead_id: 'lead-1',
          tag_id: 'tag-1',
          applied_by: 'user-1',
        }),
      );
      expect(qb.onConflict).toHaveBeenCalledWith(['lead_id', 'tag_id']);
      expect(qb.ignore).toHaveBeenCalled();
    });
  });

  describe('removeTagFromLead', () => {
    it('deletes the lead_tag row', async () => {
      const qb = makeQueryBuilder({
        delete: vi.fn().mockReturnThis(),
        then: vi.fn((_cb: (v: unknown) => unknown) => Promise.resolve(_cb(undefined))),
      });
      const db = makeDb(qb);

      await removeTagFromLead(db, 'lead-1', 'tag-1');

      expect(db).toHaveBeenCalledWith('crm_leads.lead_tags');
      expect(qb.where).toHaveBeenCalledWith({ lead_id: 'lead-1', tag_id: 'tag-1' });
      expect(qb.delete).toHaveBeenCalled();
    });
  });

  describe('findTagsByLeadId', () => {
    it('joins lead_tags correctly', async () => {
      const qb = makeQueryBuilder({
        then: vi.fn((_cb: (v: unknown) => unknown) => Promise.resolve(_cb([fakeTag]))),
      });
      const db = makeDb(qb);

      const result = await findTagsByLeadId(db, 'lead-1');

      expect(db).toHaveBeenCalledWith('crm_leads.tags');
      expect(qb.join).toHaveBeenCalledWith(
        'crm_leads.lead_tags',
        'crm_leads.lead_tags.tag_id',
        'crm_leads.tags.id',
      );
      expect(qb.where).toHaveBeenCalledWith('crm_leads.lead_tags.lead_id', 'lead-1');
      expect(qb.select).toHaveBeenCalledWith('crm_leads.tags.*');
      expect(result).toEqual([fakeTag]);
    });
  });
});
