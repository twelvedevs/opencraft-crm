import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import cors from '@fastify/cors';
import type { Pool } from 'pg';
import type { AuthProvider } from './providers/auth-provider.interface.js';
import { env } from './env.js';
import { healthRoutes } from './routes/health.js';

export async function buildApp(
  pool: Pool,
  provider: AuthProvider,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: env.LOG_LEVEL } });

  await app.register(sensible);
  await app.register(cors, { origin: env.CORS_ORIGIN });

  app.decorate('pool', pool);
  app.decorate('provider', provider);

  await app.register(healthRoutes, { pool });

  return app;
}
