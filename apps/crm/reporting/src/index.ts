import Fastify, { type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import { authPlugin } from '@ortho/auth-middleware';
import { openapiPlugin } from '@ortho/openapi';
import { createLogger } from '@ortho/logger';
import { requestLoggingPlugin } from '@ortho/fastify-logger';
import db, { destroy } from './db.js';
import { env } from './env.js';
import { reconcile } from './services/schedule-manager.js';
import { healthRoutes } from './routes/health.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { channelPerformanceRoutes } from './routes/metrics/channel-performance.js';
import { locationComparisonRoutes } from './routes/metrics/location-comparison.js';
import { coordinatorPerformanceRoutes } from './routes/metrics/coordinator-performance.js';
import { campaignAnalyticsRoutes } from './routes/metrics/campaign-analytics.js';
import { reportConfigRoutes } from './routes/report-configs.js';
import { scheduleRoutes } from './routes/schedules.js';
import { runRoutes } from './routes/runs.js';
import { configRoutes } from './routes/config.js';

// Importing this module starts the BullMQ Worker as a module-level side effect.
// HTTP server and Worker run in the same process (per spec Section 1.1).
import './jobs/generate-report.js';

const log = createLogger('crm-reporting');
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });

await app.register(sensible);
await app.register(requestLoggingPlugin, { logger: log });

await app.register(openapiPlugin, {
  title: 'Reporting Service',
  description: 'Ortho-specific reporting — cost per case, ROAS, funnel rates, coordinator metrics',
  tags: [
    { name: 'Dashboard', description: 'Executive dashboard' },
    { name: 'Metrics', description: 'Aggregated performance metrics' },
    { name: 'Runs', description: 'Report run management' },
    { name: 'Schedules', description: 'Scheduled report delivery' },
    { name: 'Report Configs', description: 'Saved report configurations' },
    { name: 'Config', description: 'Revenue and global config' },
  ],
});

// ---------------------------------------------------------------------------
// Unauthenticated routes
// ---------------------------------------------------------------------------
await app.register(healthRoutes);

// ---------------------------------------------------------------------------
// Authenticated scope
// ---------------------------------------------------------------------------
await app.register(async (scope) => {
  await scope.register(authPlugin, { jwksUrl: env.IDENTITY_JWKS_URL });

  // Dashboard and metrics  →  US-012
  await scope.register(dashboardRoutes);
  await scope.register(channelPerformanceRoutes);
  await scope.register(locationComparisonRoutes);
  await scope.register(coordinatorPerformanceRoutes);
  await scope.register(campaignAnalyticsRoutes);

  // Report-config CRUD + generate  →  US-013
  await scope.register(reportConfigRoutes);

  // Schedules, runs, revenue config  →  US-014
  await scope.register(scheduleRoutes);
  await scope.register(runRoutes);
  await scope.register(configRoutes);
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
