import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import type { Knex } from './db.js';
import { SegmentRepository } from './services/segment-repository.js';
import { healthRoutes } from './routes/health.js';
import { segmentRoutes } from './routes/segments.js';
import { checkRoutes } from './routes/check.js';

export async function buildApp(
  db: Knex,
  redis: Redis,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(sensible);

  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('segmentRepository', new SegmentRepository(db));

  app.addHook('onClose', async () => {
    await redis.quit();
  });

  await app.register(healthRoutes);
  await app.register(segmentRoutes);
  await app.register(checkRoutes);

  return app;
}
