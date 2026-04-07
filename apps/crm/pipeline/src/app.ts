import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import { createLogger } from '@ortho/logger';
import type { EventBus } from '@ortho/event-bus';
import type { Knex } from 'knex';
import { internalAuthPlugin } from './plugins/internal-auth.js';
import { membershipRoutes } from './routes/memberships.js';
import { transitionRoutes } from './routes/transitions.js';
import { conversionRoutes } from './routes/conversions.js';

export async function buildApp(db: Knex, eventBus: EventBus): Promise<FastifyInstance> {
  const log = createLogger('crm-pipeline');
  const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });

  await app.register(sensible);
  await app.register(internalAuthPlugin);

  app.get('/health', async () => ({ ok: true }));

  await app.register(membershipRoutes, { prefix: '/pipeline', db, eventBus });
  await app.register(transitionRoutes, { prefix: '/pipeline', db, eventBus });
  await app.register(conversionRoutes, { prefix: '/pipeline', db, eventBus });

  return app;
}
