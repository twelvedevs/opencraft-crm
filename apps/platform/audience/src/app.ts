import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import type { Knex } from './db.js';
import { healthRoutes } from './routes/health.js';

export async function buildApp(
  db: Knex,
  redis: Redis,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(sensible);

  app.decorate('db', db);
  app.decorate('redis', redis);

  app.addHook('onClose', async () => {
    await redis.quit();
  });

  await app.register(healthRoutes);

  return app;
}
