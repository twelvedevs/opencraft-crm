import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import { authPlugin } from '@ortho/auth-middleware';
import { createLogger } from '@ortho/logger';
import type { EventBus } from '@ortho/event-bus';
import type { Knex } from 'knex';
import { env } from './env.js';
import { leadsRoutes } from './routes/leads.js';
import { appointmentRoutes } from './routes/appointments.js';
import { tagRoutes } from './routes/tags.js';
import { activityRoutes } from './routes/activities.js';

export async function buildApp(db: Knex, eventBus: EventBus): Promise<FastifyInstance> {
  const log = createLogger('crm-lead');
  const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });

  await app.register(sensible);

  await app.register(authPlugin, {
    jwksUrl: env.IDENTITY_JWKS_URL,
    allowedPaths: ['/health'],
  });

  app.decorate('eventBus', eventBus);

  app.get('/health', async () => ({ ok: true }));

  await app.register(leadsRoutes, { db, eventBus });
  await app.register(appointmentRoutes, { db, eventBus });
  await app.register(tagRoutes, { db, eventBus });
  await app.register(activityRoutes, { db, eventBus });

  return app;
}
