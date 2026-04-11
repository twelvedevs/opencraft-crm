import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import { authPlugin } from '@ortho/auth-middleware';
import { openapiPlugin } from '@ortho/openapi';
import { createLogger } from '@ortho/logger';
import type { Knex } from 'knex';
import { env } from './env.js';
import { campaignsRoutes } from './routes/campaigns.js';
import { workflowRoutes } from './routes/workflow.js';
import { commentsRoutes } from './routes/comments.js';
import { diagnosticsRoutes } from './routes/diagnostics.js';

export async function buildApp(db: Knex): Promise<FastifyInstance> {
  const log = createLogger('crm-campaign');
  const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });

  await app.register(sensible);

  await app.register(openapiPlugin, {
    title: 'Campaign Service',
    description: 'Email broadcast campaigns with approval workflow',
    tags: [
      { name: 'Campaigns', description: 'Campaign management' },
      { name: 'Workflow', description: 'Approval and scheduling workflow' },
      { name: 'Comments', description: 'Review comments' },
      { name: 'Diagnostics', description: 'Send diagnostics and spam checking' },
    ],
  });

  await app.register(authPlugin, {
    jwksUrl: env.IDENTITY_JWKS_URL,
    allowedPaths: ['/health'],
  });

  app.get('/health', { schema: { hide: true } as object }, async () => ({ ok: true }));

  await app.register(campaignsRoutes, { prefix: '/campaigns', db });
  await app.register(workflowRoutes, { prefix: '/campaigns', db });
  await app.register(commentsRoutes, { prefix: '/campaigns', db });
  await app.register(diagnosticsRoutes, { prefix: '/campaigns', db });

  return app;
}
