import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import cors from '@fastify/cors';
import { authPlugin } from '@ortho/auth-middleware';
import { createLogger } from '@ortho/logger';
import type { Pool } from 'pg';
import { env } from './env.js';

export async function buildApp(pool: Pool): Promise<FastifyInstance> {
  const log = createLogger('platform-media');
  const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });

  await app.register(sensible);
  await app.register(cors, { origin: env.CORS_ORIGIN });

  await app.register(authPlugin, {
    jwksUrl: env.IDENTITY_JWKS_URL,
    allowedPaths: ['/health', '/ready'],
  });

  app.decorate('pool', pool);

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_req, reply) => {
    reply.code(200).send();
  });

  return app;
}
