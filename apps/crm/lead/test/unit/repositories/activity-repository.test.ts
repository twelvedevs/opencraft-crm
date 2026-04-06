import { describe, it, expect, vi } from 'vitest';
import type { Knex } from 'knex';
import {
  insertActivity,
  listActivities,
  findBySourceEventId,
} from '../../../src/repositories/activity-repository.js';

const fakeActivity = {
  id: 'act-1',
  lead_id: 'lead-1',
  event_type: 'lead.created',
  actor_type: 'system',
  actor_id: null,
  payload: {},
  occurred_at: '2026-01-01T12:00:00Z',
  source_event_id: 'evt-abc',
};

function makeQueryBuilder(overrides: Record<string, unknown> = {}) {
  const qb: Record<string, unknown> = {
    insert: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([fakeActivity]),
    where: vi.fn().mockReturnThis(),
    whereIn: vi.fn().mockReturnThis(),
    whereRaw: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(fakeActivity),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockResolvedValue(1),
    select: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([fakeActivity]),
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

describe('activity-repository', () => {
  describe('insertActivity', () => {
    it('uses ON CONFLICT (source_event_id) DO NOTHING', async () => {
      const qb = makeQueryBuilder({
        then: vi.fn((_cb: (v: unknown) => unknown) => Promise.resolve(_cb(undefined))),
      });
      const db = makeDb(qb);

      const data = {
        lead_id: 'lead-1',
        event_type: 'lead.created',
        actor_type: 'system' as const,
        actor_id: null,
        payload: {},
        occurred_at: '2026-01-01T12:00:00Z',
        source_event_id: 'evt-abc',
      };

      await insertActivity(db, data);

      expect(db).toHaveBeenCalledWith('crm_leads.lead_activities');
      expect(qb.insert).toHaveBeenCalledWith(data);
      expect(qb.onConflict).toHaveBeenCalledWith('source_event_id');
      expect(qb.ignore).toHaveBeenCalled();
    });
  });

  describe('listActivities', () => {
    it('orders by occurred_at DESC, id DESC', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);

      await listActivities(db, 'lead-1', {});

      expect(qb.where).toHaveBeenCalledWith({ lead_id: 'lead-1' });
      const orderByCalls = (qb.orderBy as ReturnType<typeof vi.fn>).mock.calls;
      expect(orderByCalls[0]).toEqual(['occurred_at', 'desc']);
      expect(orderByCalls[1]).toEqual(['id', 'desc']);
    });

    it('filters by eventTypes when provided', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);

      await listActivities(db, 'lead-1', { eventTypes: ['lead.created', 'lead.updated'] });

      expect(qb.whereIn).toHaveBeenCalledWith('event_type', ['lead.created', 'lead.updated']);
    });

    it('does not filter eventTypes when not provided', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);

      await listActivities(db, 'lead-1', {});

      expect(qb.whereIn).not.toHaveBeenCalled();
    });

    it('applies cursor filter when provided', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);

      const cursor = Buffer.from(
        JSON.stringify({
          lastSeenOccurredAt: '2026-01-01T12:00:00Z',
          lastSeenId: 'act-1',
        }),
      ).toString('base64');

      await listActivities(db, 'lead-1', { cursor });

      expect(qb.whereRaw).toHaveBeenCalledWith(
        '(occurred_at, id) < (?, ?)',
        ['2026-01-01T12:00:00Z', 'act-1'],
      );
    });

    it('returns nextCursor when more rows than limit', async () => {
      const act1 = { ...fakeActivity, id: 'act-1', occurred_at: '2026-01-02T00:00:00Z' };
      const act2 = { ...fakeActivity, id: 'act-2', occurred_at: '2026-01-01T00:00:00Z' };
      const extra = { ...fakeActivity, id: 'act-3', occurred_at: '2025-12-31T00:00:00Z' };

      const qb = makeQueryBuilder({
        limit: vi.fn().mockResolvedValue([act1, act2, extra]),
      });
      const db = makeDb(qb);

      const result = await listActivities(db, 'lead-1', { limit: 2 });

      expect(result.activities).toHaveLength(2);
      expect(result.nextCursor).not.toBeNull();

      // Verify cursor content
      const decoded = JSON.parse(Buffer.from(result.nextCursor!, 'base64').toString('utf-8'));
      expect(decoded.lastSeenOccurredAt).toBe('2026-01-01T00:00:00Z');
      expect(decoded.lastSeenId).toBe('act-2');
    });

    it('returns null nextCursor when rows fit within limit', async () => {
      const qb = makeQueryBuilder({
        limit: vi.fn().mockResolvedValue([fakeActivity]),
      });
      const db = makeDb(qb);

      const result = await listActivities(db, 'lead-1', { limit: 2 });

      expect(result.activities).toHaveLength(1);
      expect(result.nextCursor).toBeNull();
    });
  });

  describe('findBySourceEventId', () => {
    it('returns activity when found', async () => {
      const qb = makeQueryBuilder();
      const db = makeDb(qb);

      const result = await findBySourceEventId(db, 'evt-abc');

      expect(qb.where).toHaveBeenCalledWith({ source_event_id: 'evt-abc' });
      expect(result).toEqual(fakeActivity);
    });

    it('returns null when not found', async () => {
      const qb = makeQueryBuilder({
        first: vi.fn().mockResolvedValue(undefined),
      });
      const db = makeDb(qb);

      const result = await findBySourceEventId(db, 'missing');

      expect(result).toBeNull();
    });
  });
});
