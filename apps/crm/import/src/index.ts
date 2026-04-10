import Fastify, { type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import { authPlugin } from '@ortho/auth-middleware';
import { createLogger } from '@ortho/logger';
import db, { destroy } from './db.js';
import { env } from './env.js';

const log = createLogger('crm-import');
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });

await app.register(sensible);

// Health check (unauthenticated)
app.get('/health', async () => ({ ok: true }));

// Authenticated scope — routes and worker will be wired in US-014
await app.register(async (scope) => {
  await scope.register(authPlugin, { jwksUrl: env.IDENTITY_JWKS_URL });
});

await app.listen({ port: env.PORT, host: '0.0.0.0' });

log.info({ port: env.PORT }, 'Import Service listening');

process.on('SIGTERM', async () => {
  log.info('SIGTERM received — shutting down');
  await app.close();
  await destroy();
  process.exit(0);
});
