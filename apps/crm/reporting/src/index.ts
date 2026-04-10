import Fastify, { type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import { authPlugin } from '@ortho/auth-middleware';
import { createLogger } from '@ortho/logger';
import db, { destroy } from './db.js';
import { env } from './env.js';
import { reconcile } from './services/schedule-manager.js';

// Importing this module starts the BullMQ Worker as a module-level side effect.
// HTTP server and Worker run in the same process (per spec Section 1.1).
import './jobs/generate-report.js';

const log = createLogger('crm-reporting');
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });

await app.register(sensible);

// ---------------------------------------------------------------------------
// Unauthenticated routes
// ---------------------------------------------------------------------------

// Minimal health check — a full /health + /ready implementation is added in US-014.
app.get('/health', async () => ({ status: 'ok' }));

// ---------------------------------------------------------------------------
// Authenticated scope — routes registered by US-012, US-013, US-014
// ---------------------------------------------------------------------------
await app.register(async (scope) => {
  await scope.register(authPlugin, { jwksUrl: env.IDENTITY_JWKS_URL });

  // Metric and dashboard routes  →  US-012
  // Report-config CRUD + generate  →  US-013
  // Schedules, runs, revenue config, health  →  US-014
});

// ---------------------------------------------------------------------------
// Startup: reconcile scheduled BullMQ jobs before accepting traffic
// ---------------------------------------------------------------------------
await reconcile(db);

await app.listen({ port: env.PORT, host: '0.0.0.0' });

log.info({ port: env.PORT }, 'Reporting Service listening');

process.on('SIGTERM', async () => {
  log.info('SIGTERM received — shutting down');
  await app.close();
  await destroy();
  process.exit(0);
});
