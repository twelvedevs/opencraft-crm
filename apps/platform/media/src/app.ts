import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { authPlugin } from '@ortho/auth-middleware';
import { openapiPlugin } from '@ortho/openapi';
import { createLogger } from '@ortho/logger';
import { requestLoggingPlugin } from '@ortho/fastify-logger';
import type { Pool } from 'pg';
import type { Knex } from 'knex';
import { env } from './env.js';
import { uploadRoutes } from './routes/upload.js';
import { fileRoutes } from './routes/files.js';
import { internalRoutes } from './routes/internal.js';

export async function buildApp(pool: Pool, knex: Knex): Promise<FastifyInstance> {
  const log = createLogger('platform-media');
  const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });

  await app.register(sensible);
  await app.register(requestLoggingPlugin, { logger: log });
  await app.register(openapiPlugin, {
    title: 'Media Service',
    description: 'File upload, S3 storage, and CDN delivery',
    tags: [
      { name: 'Upload', description: 'File upload flows' },
      { name: 'Files', description: 'File retrieval and deletion' },
      { name: 'Internal', description: 'Internal service file operations' },
    ],
  });
  await app.register(cors, { origin: env.CORS_ORIGIN });
  await app.register(multipart, { limits: { fileSize: env.MAX_FILE_SIZE_BYTES } });

  await app.register(authPlugin, {
    jwksUrl: env.IDENTITY_JWKS_URL,
    allowedPaths: ['/health', '/ready'],
  });

  app.decorate('pool', pool);
  app.decorate('knex', knex);

  app.get('/health', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async () => ({ status: 'ok' }));
  app.get('/ready', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async (_req, reply) => {
    reply.code(200).send();
  });

  await uploadRoutes(app, { knex });
  await fileRoutes(app, { knex });
  await app.register(internalRoutes, { knex });

  return app;
}
