import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SnapshotManager,
  SegmentMismatchError,
  SnapshotSizeExceededError,
} from '../../src/services/snapshot-manager.js';
import type { SnapshotsRepository } from '../../src/repositories/snapshots.repository.js';
import type { FilterEvaluator } from '../../src/services/filter-evaluator.js';

function createMockRepo(): SnapshotsRepository {
  return {
    createIfNotExists: vi.fn().mockResolvedValue(undefined),
    validateSegmentId: vi.fn().mockResolvedValue(true),
    getMatchedCount: vi.fn().mockResolvedValue(0),
    addMembers: vi.fn().mockResolvedValue(0),
    incrementMatchedCount: vi.fn().mockResolvedValue(undefined),
    seal: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn(),
    findMembers: vi.fn(),
  } as unknown as SnapshotsRepository;
}

function createMockEvaluator(matchAll = true): FilterEvaluator {
  return {
    evaluate: vi.fn().mockReturnValue(matchAll),
  } as unknown as FilterEvaluator;
}

describe('SnapshotManager', () => {
  let repo: ReturnType<typeof createMockRepo>;
  let evaluator: ReturnType<typeof createMockEvaluator>;
  let enqueueCleanup: ReturnType<typeof vi.fn>;
  let manager: SnapshotManager;

  beforeEach(() => {
    vi.restoreAllMocks();
    repo = createMockRepo();
    evaluator = createMockEvaluator(true);
    enqueueCleanup = vi.fn().mockResolvedValue(undefined);
    manager = new SnapshotManager(
      repo as unknown as SnapshotsRepository,
      evaluator as unknown as FilterEvaluator,
      enqueueCleanup,
    );
  });

  it('first batch (done: false) creates snapshot and accumulates matched entities', async () => {
    const result = await manager.processBatch({
      snapshotId: 'snap-1',
      segmentId: 'seg-1',
      segmentVersion: 1,
      filterSnapshot: { op: 'AND', conditions: [] },
      entities: [
        { entity_id: 'e1', name: 'Alice' },
        { entity_id: 'e2', name: 'Bob' },
      ],
      done: false,
      createdBy: null,
    });

    expect((repo.createIfNotExists as any)).toHaveBeenCalledOnce();
    expect((repo.addMembers as any)).toHaveBeenCalledWith('snap-1', ['e1', 'e2']);
    expect((repo.incrementMatchedCount as any)).toHaveBeenCalledWith('snap-1', 2);
    expect(result.matchedCount).toBe(2);
    expect(result.status).toBe('accumulating');
    expect((repo.seal as any)).not.toHaveBeenCalled();
    expect(enqueueCleanup).not.toHaveBeenCalled();
  });

  it('second batch adds to existing, matched_count increments correctly', async () => {
    // After first batch, count is 2
    (repo.getMatchedCount as any).mockResolvedValue(2);

    const result = await manager.processBatch({
      snapshotId: 'snap-1',
      segmentId: 'seg-1',
      segmentVersion: 1,
      filterSnapshot: { op: 'AND', conditions: [] },
      entities: [{ entity_id: 'e3', name: 'Charlie' }],
      done: false,
      createdBy: null,
    });

    expect((repo.addMembers as any)).toHaveBeenCalledWith('snap-1', ['e3']);
    expect((repo.incrementMatchedCount as any)).toHaveBeenCalledWith('snap-1', 1);
    expect(result.matchedCount).toBe(3); // 2 existing + 1 new
  });

  it('final batch (done: true) seals snapshot and calls enqueueCleanup with 48h delay', async () => {
    const result = await manager.processBatch({
      snapshotId: 'snap-1',
      segmentId: 'seg-1',
      segmentVersion: 1,
      filterSnapshot: { op: 'AND', conditions: [] },
      entities: [{ entity_id: 'e1', name: 'Alice' }],
      done: true,
      createdBy: null,
    });

    expect((repo.seal as any)).toHaveBeenCalledWith('snap-1');
    expect(enqueueCleanup).toHaveBeenCalledWith('snap-1', 48 * 60 * 60 * 1000);
    expect(result.status).toBe('ready');
  });

  it('entity that fails filter is not included in matched_ids', async () => {
    (evaluator.evaluate as any)
      .mockReturnValueOnce(true)   // e1 matches
      .mockReturnValueOnce(false); // e2 does not match

    const result = await manager.processBatch({
      snapshotId: 'snap-1',
      segmentId: 'seg-1',
      segmentVersion: 1,
      filterSnapshot: { field: 'status', op: 'eq', value: 'active' },
      entities: [
        { entity_id: 'e1', status: 'active' },
        { entity_id: 'e2', status: 'inactive' },
      ],
      done: false,
      createdBy: null,
    });

    expect((repo.addMembers as any)).toHaveBeenCalledWith('snap-1', ['e1']);
    expect((repo.incrementMatchedCount as any)).toHaveBeenCalledWith('snap-1', 1);
    expect(result.matchedCount).toBe(1);
  });

  it('duplicate entity_id across batches — addMembers called with both, ON CONFLICT handles dedup', async () => {
    // First batch
    await manager.processBatch({
      snapshotId: 'snap-1',
      segmentId: 'seg-1',
      segmentVersion: 1,
      filterSnapshot: { op: 'AND', conditions: [] },
      entities: [{ entity_id: 'e1', name: 'Alice' }],
      done: false,
      createdBy: null,
    });

    // Second batch with same entity_id
    (repo.getMatchedCount as any).mockResolvedValue(1);
    await manager.processBatch({
      snapshotId: 'snap-1',
      segmentId: 'seg-1',
      segmentVersion: 1,
      filterSnapshot: { op: 'AND', conditions: [] },
      entities: [{ entity_id: 'e1', name: 'Alice' }],
      done: false,
      createdBy: null,
    });

    // addMembers called in both batches — DB-level ON CONFLICT DO NOTHING handles dedup
    expect((repo.addMembers as any)).toHaveBeenCalledTimes(2);
    expect((repo.addMembers as any)).toHaveBeenNthCalledWith(1, 'snap-1', ['e1']);
    expect((repo.addMembers as any)).toHaveBeenNthCalledWith(2, 'snap-1', ['e1']);
  });

  it('total cap: batch pushing above 100,000 throws SnapshotSizeExceededError', async () => {
    (repo.getMatchedCount as any).mockResolvedValue(99_999);

    await expect(
      manager.processBatch({
        snapshotId: 'snap-1',
        segmentId: 'seg-1',
        segmentVersion: 1,
        filterSnapshot: { op: 'AND', conditions: [] },
        entities: [
          { entity_id: 'e1', name: 'A' },
          { entity_id: 'e2', name: 'B' },
        ],
        done: false,
        createdBy: null,
      }),
    ).rejects.toThrow(SnapshotSizeExceededError);
  });

  it('segment_id mismatch throws SegmentMismatchError', async () => {
    (repo.validateSegmentId as any).mockResolvedValue(false);

    await expect(
      manager.processBatch({
        snapshotId: 'snap-1',
        segmentId: 'seg-1',
        segmentVersion: 1,
        filterSnapshot: { op: 'AND', conditions: [] },
        entities: [{ entity_id: 'e1', name: 'Alice' }],
        done: false,
        createdBy: null,
      }),
    ).rejects.toThrow(SegmentMismatchError);
  });
});
