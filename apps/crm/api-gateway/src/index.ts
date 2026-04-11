import Fastify from 'fastify';
import replyFrom from '@fastify/reply-from';
import { createLogger } from '@ortho/logger';
import { config } from './config.js';
import requestIdPlugin from './plugins/request-id.js';
import authPlugin from './plugins/auth.js';
import rateLimitPlugin from './plugins/rate-limit.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import healthRoutes from './routes/health.js';
import leadsRoutes from './routes/leads.js';
import conversationsRoutes from './routes/conversations.js';
import campaignsRoutes from './routes/campaigns.js';
import reportsRoutes from './routes/reports.js';
import pipelineRoutes from './routes/pipeline.js';
import referralsRoutes from './routes/referrals.js';
import importsRoutes from './routes/imports.js';
import notificationsRoutes from './routes/notifications.js';

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
// ---------------------------------------------------------------------------
// reply-from — registered before global plugins so it's available to routes
// ---------------------------------------------------------------------------
await app.register(replyFrom, {
  disableRequestLogging: true,
  undici: {
    headersTimeout: config.UPSTREAM_TIMEOUT_MS,
    bodyTimeout: config.UPSTREAM_TIMEOUT_MS,
  },
});

// ---------------------------------------------------------------------------
// Global plugins (registered in order: request-id → auth → rate-limit → error-handler)
// ---------------------------------------------------------------------------
await app.register(requestIdPlugin);
await app.register(authPlugin);
await app.register(rateLimitPlugin);
await app.register(errorHandlerPlugin);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
// Health check (no prefix)
await app.register(healthRoutes);

// Service proxies under /v1
await app.register(leadsRoutes, { prefix: '/v1/leads' });
await app.register(conversationsRoutes, { prefix: '/v1/conversations' });
await app.register(campaignsRoutes, { prefix: '/v1/campaigns' });
await app.register(reportsRoutes, { prefix: '/v1/reports' });
await app.register(pipelineRoutes, { prefix: '/v1/pipeline' });
await app.register(referralsRoutes, { prefix: '/v1/referrals' });
await app.register(importsRoutes, { prefix: '/v1/imports' });
await app.register(notificationsRoutes, { prefix: '/v1/notifications' });

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  log.error(err, 'Failed to start server');
  process.exit(1);
}
