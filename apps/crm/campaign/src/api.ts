import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import { authPlugin } from '@ortho/auth-middleware';
import { createLogger } from '@ortho/logger';
import type { Knex } from 'knex';
import { env } from './env.js';
import { campaignsRoutes } from './routes/campaigns.js';

export async function buildApp(db: Knex): Promise<FastifyInstance> {
  const log = createLogger('crm-campaign');
  const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });

  await app.register(sensible);

  await app.register(authPlugin, {
    jwksUrl: env.IDENTITY_JWKS_URL,
    allowedPaths: ['/health'],
  });

  app.get('/health', async () => ({ ok: true }));

  await app.register(campaignsRoutes, { prefix: '/campaigns', db });

  return app;
}
