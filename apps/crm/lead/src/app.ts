import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import { authPlugin } from '@ortho/auth-middleware';
import { openapiPlugin } from '@ortho/openapi';
import { createLogger } from '@ortho/logger';
import { requestLoggingPlugin } from '@ortho/fastify-logger';
import type { EventBus } from '@ortho/event-bus';
import type { Knex } from 'knex';
import { env } from './env.js';
import { leadsRoutes } from './routes/leads.js';
import { appointmentRoutes } from './routes/appointments.js';
import { tagRoutes } from './routes/tags.js';
import { activityRoutes } from './routes/activities.js';

export async function buildApp(db: Knex, eventBus: EventBus): Promise<FastifyInstance> {
  const log = createLogger('crm-lead');
  const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });

  await app.register(sensible);
  await app.register(requestLoggingPlugin, { logger: log });

  await app.register(openapiPlugin, {
    title: 'Lead Service',
    description: 'Lead records, attribution, deduplication, and activity timeline',
    tags: [
      { name: 'Leads', description: 'Lead CRUD and deduplication' },
      { name: 'Activities', description: 'Lead activity timeline' },
      { name: 'Appointments', description: 'Lead appointment management' },
      { name: 'Tags', description: 'Tag management and assignment' },
    ],
  });

  await app.register(authPlugin, {
    jwksUrl: env.IDENTITY_JWKS_URL,
    allowedPaths: ['/health'],
  });

  app.decorate('eventBus', eventBus);

  app.get('/health', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async () => ({ ok: true }));

  await app.register(leadsRoutes, { db, eventBus });
  await app.register(appointmentRoutes, { db, eventBus });
  await app.register(tagRoutes, { db, eventBus });
  await app.register(activityRoutes, { db, eventBus });

  return app;
}
