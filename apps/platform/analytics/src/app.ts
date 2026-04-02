import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import type { Pool } from 'pg';
import { apiKeyAuthPlugin } from './plugins/api-key-auth.js';
import { healthRoutes } from './routes/health.js';

export async function buildApp(pool: Pool): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(sensible);
  await app.register(apiKeyAuthPlugin);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  await app.register(healthRoutes, { pool });

  return app;
}
