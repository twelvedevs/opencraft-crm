import Fastify from 'fastify';
import { createLogger } from '@ortho/logger';
import { config } from './config.js';
import requestIdPlugin from './plugins/request-id.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const log = createLogger('crm-api-gateway');

// ---------------------------------------------------------------------------
// Fastify instance
// ---------------------------------------------------------------------------
const app = Fastify({
  loggerInstance: log,
  bodyLimit: config.MAX_BODY_SIZE_BYTES,
  requestIdHeader: 'x-request-id',
  disableRequestLogging: false,
});

// ---------------------------------------------------------------------------
// Global plugins (registered in order: request-id → auth → rate-limit → error-handler)
// ---------------------------------------------------------------------------
await app.register(requestIdPlugin);
// await app.register(authPlugin);
// await app.register(rateLimitPlugin);
// await app.register(errorHandlerPlugin);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
// Health check (no prefix)
// await app.register(healthRoutes);

// Service proxies under /v1
// await app.register(leadsRoutes, { prefix: '/v1/leads' });
// await app.register(conversationsRoutes, { prefix: '/v1/conversations' });
// await app.register(campaignsRoutes, { prefix: '/v1/campaigns' });
// await app.register(reportsRoutes, { prefix: '/v1/reports' });
// await app.register(pipelineRoutes, { prefix: '/v1/pipeline' });
// await app.register(referralsRoutes, { prefix: '/v1/referrals' });
// await app.register(importsRoutes, { prefix: '/v1/imports' });
// await app.register(notificationsRoutes, { prefix: '/v1/notifications' });

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  log.error(err, 'Failed to start server');
  process.exit(1);
}
