import type { SnapshotsRepository } from '../repositories/snapshots.repository.js';
import type { FilterEvaluator } from './filter-evaluator.js';

export class SegmentMismatchError extends Error {
  constructor(snapshotId: string, expectedSegmentId: string) {
    super(`Snapshot ${snapshotId} belongs to a different segment than ${expectedSegmentId}`);
    this.name = 'SegmentMismatchError';
  }
}

export class SnapshotSizeExceededError extends Error {
  constructor(snapshotId: string) {
    super(`Snapshot ${snapshotId} would exceed the 100,000 member cap`);
    this.name = 'SnapshotSizeExceededError';
  }
}

export interface ProcessBatchParams {
  snapshotId: string;
  segmentId: string | null;
  segmentVersion: number | null;
  filterSnapshot: unknown;
  entities: Array<{ entity_id: string; [key: string]: unknown }>;
  done: boolean;
  createdBy: string | null;
}

export interface ProcessBatchResult {
  snapshotId: string;
  matchedCount: number;
  status: string;
}

const SNAPSHOT_CAP = 100_000;
const SNAPSHOT_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

export class SnapshotManager {
  private snapshotsRepo: SnapshotsRepository;
  private filterEvaluator: FilterEvaluator;
  private enqueueCleanup: (snapshotId: string, delayMs: number) => Promise<void>;

  constructor(
    snapshotsRepo: SnapshotsRepository,
    filterEvaluator: FilterEvaluator,
    enqueueCleanup: (snapshotId: string, delayMs: number) => Promise<void>,
  ) {
    this.snapshotsRepo = snapshotsRepo;
    this.filterEvaluator = filterEvaluator;
    this.enqueueCleanup = enqueueCleanup;
  }

  async processBatch(params: ProcessBatchParams): Promise<ProcessBatchResult> {
    const { snapshotId, segmentId, segmentVersion, filterSnapshot, entities, done, createdBy } = params;

    // 1. Create snapshot row if not exists (idempotent)
    await this.snapshotsRepo.createIfNotExists({
      id: snapshotId,
      segment_id: segmentId,
      segment_version: segmentVersion,
      filter_snapshot: filterSnapshot,
      expires_at: new Date(Date.now() + SNAPSHOT_TTL_MS),
      created_by: createdBy,
    });

    // 2. Validate segment_id matches
    if (segmentId !== null) {
      const valid = await this.snapshotsRepo.validateSegmentId(snapshotId, segmentId);
      if (!valid) {
        throw new SegmentMismatchError(snapshotId, segmentId);
      }
    }

    // 3. Filter entities
    const matchedIds: string[] = [];
    for (const entity of entities) {
      if (this.filterEvaluator.evaluate(filterSnapshot, entity)) {
        matchedIds.push(entity.entity_id);
      }
    }

    // 4. Check total cap
    const currentCount = await this.snapshotsRepo.getMatchedCount(snapshotId);
    if (currentCount + matchedIds.length > SNAPSHOT_CAP) {
      throw new SnapshotSizeExceededError(snapshotId);
    }

    // 5. Add members and increment count
    if (matchedIds.length > 0) {
      await this.snapshotsRepo.addMembers(snapshotId, matchedIds);
      await this.snapshotsRepo.incrementMatchedCount(snapshotId, matchedIds.length);
    }

    // 6. If done, seal and enqueue cleanup
    if (done) {
      await this.snapshotsRepo.seal(snapshotId);
      await this.enqueueCleanup(snapshotId, SNAPSHOT_TTL_MS);
    }

    const newTotal = currentCount + matchedIds.length;

    return {
      snapshotId,
      matchedCount: newTotal,
      status: done ? 'ready' : 'accumulating',
    };
  }
}
