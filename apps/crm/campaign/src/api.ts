import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import { authPlugin } from '@ortho/auth-middleware';
import { createLogger } from '@ortho/logger';
import type { Knex } from 'knex';
import { env } from './env.js';

export async function buildApp(db: Knex): Promise<FastifyInstance> {
  const log = createLogger('crm-campaign');
  const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });

  await app.register(sensible);

  await app.register(authPlugin, {
    jwksUrl: env.IDENTITY_JWKS_URL,
    allowedPaths: ['/health'],
  });

  app.get('/health', async () => ({ ok: true }));

  // Campaign routes registered under /campaigns prefix (stubs for now)
  await app.register(
    async (instance) => {
      instance.get('/', async (_req, reply) => reply.code(501).send({ error: 'not implemented' }));
      instance.post('/', async (_req, reply) => reply.code(501).send({ error: 'not implemented' }));
    },
    { prefix: '/campaigns' },
  );

  return app;
}
