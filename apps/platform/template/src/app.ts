import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import type { Knex } from 'knex';
import { requireAuth, requireRole } from './plugins/auth.js';
import { openapiPlugin } from '@ortho/openapi';
import { createLogger } from '@ortho/logger';
import { requestLoggingPlugin } from '@ortho/fastify-logger';

export async function buildApp(db: Knex, jwtSecret: string): Promise<FastifyInstance> {
  const log = createLogger('platform-template');
  const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });

  await app.register(sensible);
  await app.register(requestLoggingPlugin, { logger: log });

  await app.register(openapiPlugin, {
    title: 'Template Service',
    description: 'Template storage and rendering engine',
    tags: [
      { name: 'Templates', description: 'Template management and versioning' },
      { name: 'Render', description: 'Template rendering with merge tags' },
    ],
  });

  app.decorate('db', db);
  app.decorate('jwtSecret', jwtSecret);

  // Bind auth helpers to jwtSecret so route handlers don't need to pass it manually.
  // Usage: app.requireAuth() or app.requireRole('marketing_manager')
  app.decorate('requireAuth', () => requireAuth(jwtSecret));
  app.decorate('requireRole', (role: string) => requireRole(role, jwtSecret));

  app.get('/health', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async (_request, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  await app.register(import('./routes/templates.js'));
  await app.register(import('./routes/render.js'));

  return app;
}
