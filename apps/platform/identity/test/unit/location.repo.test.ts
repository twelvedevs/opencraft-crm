import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

function makePool(rows: unknown[] = []): Pool {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool;
}

// Dynamic import after vi.mock calls
let repo: typeof import('../../src/repositories/location.repo.js');

beforeEach(async () => {
  vi.resetModules();
  repo = await import('../../src/repositories/location.repo.js');
});

describe('location.repo', () => {
  describe('findAll', () => {
    it('returns all rows when no status filter', async () => {
      const row = { id: 'uuid-1', name: 'A', phone: '+1', address: '1 St', timezone: 'UTC', status: 'active' };
      const pool = makePool([row]);
      const result = await repo.findAll(pool);
      expect(result).toEqual([row]);
      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]?];
      expect(call[0]).toContain('FROM platform_identity.locations');
      expect(call[1]).toEqual([]);
    });

    it('appends WHERE clause when status filter provided', async () => {
      const pool = makePool([]);
      await repo.findAll(pool, 'active');
      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]?];
      expect(call[0]).toContain('WHERE status =');
      expect(call[1]).toEqual(['active']);
    });
  });

  describe('findById', () => {
    it('returns row when found', async () => {
      const row = { id: 'uuid-1', name: 'A' };
      const pool = makePool([row]);
      const result = await repo.findById(pool, 'uuid-1');
      expect(result).toEqual(row);
    });

    it('returns null when not found', async () => {
      const pool = makePool([]);
      const result = await repo.findById(pool, 'missing');
      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('inserts and returns the new row', async () => {
      const row = { id: 'uuid-new', name: 'B', phone: '+2', address: '2 St', timezone: 'UTC', status: 'active' };
      const pool = makePool([row]);
      const result = await repo.create(pool, { name: 'B', phone: '+2', address: '2 St', timezone: 'UTC' });
      expect(result).toEqual(row);
      const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]?];
      expect(call[0]).toContain('INSERT INTO platform_identity.locations');
    });
  });

  describe('update', () => {
    it('returns updated row when found', async () => {
      const row = { id: 'uuid-1', name: 'New Name' };
      const pool = makePool([row]);
      const result = await repo.update(pool, 'uuid-1', { name: 'New Name' });
      expect(result).toEqual(row);
    });

    it('returns null when not found', async () => {
      const pool = makePool([]);
      const result = await repo.update(pool, 'missing', { name: 'X' });
      expect(result).toBeNull();
    });
  });

  describe('softDelete', () => {
    it('returns true when row found and updated', async () => {
      const pool = makePool([{ id: 'uuid-1' }]);
      const result = await repo.softDelete(pool, 'uuid-1');
      expect(result).toBe(true);
    });

    it('returns false when not found', async () => {
      const pool = makePool([]);
      const result = await repo.softDelete(pool, 'missing');
      expect(result).toBe(false);
    });
  });
});
