import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import { authPlugin } from '@ortho/auth-middleware';
import { createLogger } from '@ortho/logger';
import { env } from './env.js';
import db from './db.js';
import { leadsRoutes } from './routes/leads.js';
import { appointmentRoutes } from './routes/appointments.js';

export async function buildApp(): Promise<FastifyInstance> {
  const log = createLogger('crm-lead');
  const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });

  await app.register(sensible);

  await app.register(authPlugin, {
    jwksUrl: env.IDENTITY_JWKS_URL,
    allowedPaths: ['/health'],
  });

  app.get('/health', async () => ({ ok: true }));

  await app.register(leadsRoutes, { db });
  await app.register(appointmentRoutes, { db });

  return app;
}
