import type { Knex } from './db.js';
import type { Redis } from 'ioredis';
import type { SegmentRepository } from './services/segment-repository.js';
import type { SnapshotsRepository } from './repositories/snapshots.repository.js';
import type { SnapshotManager } from './services/snapshot-manager.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Knex;
    redis: Redis;
    segmentRepository: SegmentRepository;
    snapshotsRepository: SnapshotsRepository;
    snapshotManager: SnapshotManager;
  }
}
