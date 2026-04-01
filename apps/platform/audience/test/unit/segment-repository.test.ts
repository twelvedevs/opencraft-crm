import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SegmentRepository } from '../../src/services/segment-repository.js';

function createMockDb(rows: unknown[] = []) {
  return {
    raw: vi.fn().mockResolvedValue({ rows }),
  } as any;
}

describe('SegmentRepository', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('cache hit: second call does not query DB', async () => {
    const row = {
      id: 'seg-1',
      name: 'Test',
      status: 'active',
      active_version: 1,
      current_version: 1,
      filter: { op: 'AND', conditions: [] },
    };
    db = createMockDb([row]);
    const repo = new SegmentRepository(db);

    const first = await repo.getActiveWithFilter('seg-1');
    const second = await repo.getActiveWithFilter('seg-1');

    expect(first).toEqual({
      id: 'seg-1',
      name: 'Test',
      status: 'active',
      active_version: 1,
      current_version: 1,
      filter: { op: 'AND', conditions: [] },
    });
    expect(second).toEqual(first);
    expect(db.raw).toHaveBeenCalledTimes(1);
  });

  it('cache miss after TTL: DB queried again', async () => {
    const row = {
      id: 'seg-1',
      name: 'Test',
      status: 'active',
      active_version: 1,
      current_version: 1,
      filter: { op: 'AND', conditions: [] },
    };
    db = createMockDb([row]);
    const repo = new SegmentRepository(db);

    await repo.getActiveWithFilter('seg-1');
    expect(db.raw).toHaveBeenCalledTimes(1);

    // Manipulate the cache entry to expire it
    const cache = (repo as any).cache as Map<string, { value: unknown; expiresAt: number }>;
    const entry = cache.get('seg-1')!;
    entry.expiresAt = Date.now() - 1;

    await repo.getActiveWithFilter('seg-1');
    expect(db.raw).toHaveBeenCalledTimes(2);
  });

  it('non-active segment (status=draft) returns null', async () => {
    const row = {
      id: 'seg-1',
      name: 'Draft Seg',
      status: 'draft',
      active_version: null,
      current_version: 1,
      filter: null,
    };
    db = createMockDb([row]);
    const repo = new SegmentRepository(db);

    const result = await repo.getActiveWithFilter('seg-1');
    expect(result).toBeNull();
  });

  it('segment with no active_version returns null', async () => {
    const row = {
      id: 'seg-1',
      name: 'No Version',
      status: 'active',
      active_version: null,
      current_version: 1,
      filter: null,
    };
    db = createMockDb([row]);
    const repo = new SegmentRepository(db);

    const result = await repo.getActiveWithFilter('seg-1');
    expect(result).toBeNull();
  });

  it('invalidate clears cache so next call hits DB', async () => {
    const row = {
      id: 'seg-1',
      name: 'Test',
      status: 'active',
      active_version: 1,
      current_version: 1,
      filter: { op: 'AND', conditions: [] },
    };
    db = createMockDb([row]);
    const repo = new SegmentRepository(db);

    await repo.getActiveWithFilter('seg-1');
    expect(db.raw).toHaveBeenCalledTimes(1);

    repo.invalidate('seg-1');

    await repo.getActiveWithFilter('seg-1');
    expect(db.raw).toHaveBeenCalledTimes(2);
  });
});
