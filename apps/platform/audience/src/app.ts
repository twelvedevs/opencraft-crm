import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import type { Knex } from './db.js';
import { SegmentRepository } from './services/segment-repository.js';
import { SnapshotsRepository } from './repositories/snapshots.repository.js';
import { SnapshotManager } from './services/snapshot-manager.js';
import { FilterEvaluator } from './services/filter-evaluator.js';
import { enqueueSnapshotCleanup } from './services/snapshot-cleanup.js';
import { healthRoutes } from './routes/health.js';
import { segmentRoutes } from './routes/segments.js';
import { checkRoutes } from './routes/check.js';
import { evaluateRoutes } from './routes/evaluate.js';
import { snapshotRoutes } from './routes/snapshots.js';

export async function buildApp(
  db: Knex,
  redis: Redis,
  cleanupQueue: Queue,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(sensible);

  const snapshotsRepository = new SnapshotsRepository(db);
  const filterEvaluator = new FilterEvaluator();
  const enqueueCleanup = (snapshotId: string, delayMs: number) =>
    enqueueSnapshotCleanup(cleanupQueue, snapshotId, delayMs);
  const snapshotManager = new SnapshotManager(snapshotsRepository, filterEvaluator, enqueueCleanup);

  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('segmentRepository', new SegmentRepository(db));
  app.decorate('snapshotsRepository', snapshotsRepository);
  app.decorate('snapshotManager', snapshotManager);

  app.addHook('onClose', async () => {
    await cleanupQueue.close();
    await redis.quit();
  });

  await app.register(healthRoutes);
  await app.register(segmentRoutes);
  await app.register(checkRoutes);
  await app.register(evaluateRoutes);
  await app.register(snapshotRoutes);

  return app;
}
