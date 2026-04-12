import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import { createLogger } from '@ortho/logger';
import type { EventBus } from '@ortho/event-bus';
import type { Knex } from 'knex';
import { openapiPlugin } from '@ortho/openapi';
import { internalAuthPlugin } from './plugins/internal-auth.js';
import { membershipRoutes } from './routes/memberships.js';
import { transitionRoutes } from './routes/transitions.js';
import { conversionRoutes } from './routes/conversions.js';
import { closeRoutes } from './routes/close.js';
import { historyRoutes } from './routes/history.js';

export async function buildApp(db: Knex, eventBus: EventBus): Promise<FastifyInstance> {
  const log = createLogger('crm-pipeline');
  const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });

  await app.register(sensible);
  await app.register(openapiPlugin, {
    title: 'Pipeline Engine',
    description: 'State machine for 3 patient pipelines and 13 stages',
    tags: [
      { name: 'Memberships', description: 'Pipeline membership management' },
      { name: 'Transitions', description: 'Stage transition execution' },
      { name: 'Conversions', description: 'Cross-pipeline conversion' },
      { name: 'Close', description: 'Membership archival' },
      { name: 'History', description: 'Stage transition history' },
    ],
  });
  await app.register(internalAuthPlugin);

  app.get('/health', { schema: { hide: true } as object }, async () => ({ ok: true }));

  await app.register(membershipRoutes, { prefix: '/pipeline', db, eventBus });
  await app.register(transitionRoutes, { prefix: '/pipeline', db, eventBus });
  await app.register(conversionRoutes, { prefix: '/pipeline', db, eventBus });
  await app.register(closeRoutes, { prefix: '/pipeline', db, eventBus });
  await app.register(historyRoutes, { prefix: '/pipeline', db, eventBus });

  return app;
}
