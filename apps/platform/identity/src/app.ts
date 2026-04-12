import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import cors from '@fastify/cors';
import { authPlugin } from '@ortho/auth-middleware';
import { openapiPlugin } from '@ortho/openapi';
import { createLogger } from '@ortho/logger';
import type { Pool } from 'pg';
import type { AuthProvider } from './providers/auth-provider.interface.js';
import { env } from './env.js';
import { healthRoutes } from './routes/health.js';
import { sessionRoutes } from './routes/session.js';
import { jwksRoutes } from './routes/jwks.js';
import { meRoutes } from './routes/me.js';
import { usersRoutes } from './routes/users.js';
import { apiKeysRoutes } from './routes/api-keys.js';

export async function buildApp(
  pool: Pool,
  provider: AuthProvider,
): Promise<FastifyInstance> {
  const log = createLogger('identity');
  // Cast needed: pino Logger has extra fields (msgPrefix) not in FastifyBaseLogger
  const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });

  await app.register(sensible);
  await app.register(openapiPlugin, {
    title: 'Identity Service',
    description: 'Authentication, RBAC, and multi-location scoping',
    tags: [
      { name: 'Session', description: 'Login, logout, token refresh' },
      { name: 'Me', description: 'Current user profile' },
      { name: 'Users', description: 'User management' },
      { name: 'API Keys', description: 'Service API key management' },
      { name: 'JWKS', description: 'Public key set for JWT verification' },
    ],
  });
  await app.register(cors, { origin: env.CORS_ORIGIN });

  await app.register(authPlugin, {
    jwksUrl: env.IDENTITY_JWKS_URL,
    allowedPaths: [
      '/health',
      '/ready',
      '/identity/session',
      '/identity/refresh',
      '/identity/.well-known/jwks.json',
      '/identity/api-keys/validate',
    ],
  });

  app.decorate('pool', pool);
  app.decorate('provider', provider);

  await app.register(healthRoutes, { pool });
  await app.register(sessionRoutes, { pool, provider });
  await app.register(jwksRoutes);
  await app.register(meRoutes, { pool, provider });
  await app.register(usersRoutes, { pool, provider });
  await app.register(apiKeysRoutes, { pool });

  return app;
}
