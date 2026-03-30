import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { Knex } from 'knex';
import { requireAuth, requireRole } from './plugins/auth.js';

export async function buildApp(db: Knex, jwtSecret: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(sensible);

  app.decorate('db', db);
  app.decorate('jwtSecret', jwtSecret);

  // Bind auth helpers to jwtSecret so route handlers don't need to pass it manually.
  // Usage: app.requireAuth() or app.requireRole('marketing_manager')
  app.decorate('requireAuth', () => requireAuth(jwtSecret));
  app.decorate('requireRole', (role: string) => requireRole(role, jwtSecret));

  app.get('/health', async (_request, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  await app.register(import('./routes/templates.js'));
  await app.register(import('./routes/render.js'));

  return app;
}
