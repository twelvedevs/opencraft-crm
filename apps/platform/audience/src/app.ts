import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import type { Knex } from './db.js';
import { SegmentRepository } from './services/segment-repository.js';
import { SnapshotsRepository } from './repositories/snapshots.repository.js';
import { SnapshotManager } from './services/snapshot-manager.js';
import { FilterEvaluator } from './services/filter-evaluator.js';
import { healthRoutes } from './routes/health.js';
import { segmentRoutes } from './routes/segments.js';
import { checkRoutes } from './routes/check.js';
import { evaluateRoutes } from './routes/evaluate.js';

export async function buildApp(
  db: Knex,
  redis: Redis,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(sensible);

  const snapshotsRepository = new SnapshotsRepository(db);
  const filterEvaluator = new FilterEvaluator();
  // No-op enqueueCleanup stub until US-010 wires BullMQ
  const enqueueCleanup = async (_snapshotId: string, _delayMs: number): Promise<void> => {};
  const snapshotManager = new SnapshotManager(snapshotsRepository, filterEvaluator, enqueueCleanup);

  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('segmentRepository', new SegmentRepository(db));
  app.decorate('snapshotsRepository', snapshotsRepository);
  app.decorate('snapshotManager', snapshotManager);

  app.addHook('onClose', async () => {
    await redis.quit();
  });

  await app.register(healthRoutes);
  await app.register(segmentRoutes);
  await app.register(checkRoutes);
  await app.register(evaluateRoutes);

  return app;
}
