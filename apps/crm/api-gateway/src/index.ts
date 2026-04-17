import Fastify from 'fastify';
import replyFrom from '@fastify/reply-from';
import { createLogger } from '@ortho/logger';
import { config } from './config.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    disableRequestLogging?: boolean;
  }
}
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
import locationsRoutes from './routes/locations.js';

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
  disableRequestLogging: true,
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// reply-from — registered before global plugins so it's available to routes
// ---------------------------------------------------------------------------
await app.register(replyFrom, {
  disableRequestLogging: true,
  undici: {
    // headersTimeout: guards all routes against upstreams that never start responding.
    // bodyTimeout: 0 — no body-read deadline. REST responses are small JSON that complete
    // near-instantly; the SSE stream at GET /v1/notifications/stream is long-lived and must
    // not be cut at any fixed duration. Setting bodyTimeout globally to 0 is correct for
    // both cases. headersTimeout remains the primary protection against hung upstreams.
    headersTimeout: config.UPSTREAM_TIMEOUT_MS,
    bodyTimeout: 0,
    // maxRedirections: 0 — undici does not follow redirects by default, but we make this
    // explicit. The gateway is a transparent proxy; upstream 3xx responses (e.g. the 302
    // from the Referral Service click-redirect at GET /v1/referrals/r/:code) must be
    // returned to the caller as-is to preserve click-tracking intent.
    maxRedirections: 0,
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
// Structured request logging — Section 6.4
// Logs request_id, method, path, status_code, duration_ms, upstream_service,
// plus user_id (JWT routes) and key_hash (API key routes). No body logging.
// ---------------------------------------------------------------------------
const SERVICE_BY_PREFIX: Record<string, string> = {
  leads: 'lead-service',
  pipeline: 'pipeline-service',
  conversations: 'conversation-service',
  campaigns: 'campaign-service',
  referrals: 'referral-service',
  reports: 'reporting-service',
  imports: 'import-service',
  notifications: 'notification-service',
  locations: 'identity-service',
};

function resolveUpstreamService(rawUrl: string): string {
  if (rawUrl === '/health' || rawUrl.startsWith('/health?')) return 'health';
  const match = /^\/v1\/([^/?]+)/.exec(rawUrl);
  const segment = match?.[1];
  return (segment !== undefined && SERVICE_BY_PREFIX[segment]) || 'unknown';
}

app.addHook('onResponse', (request, reply, done) => {
  if (request.routeOptions.config?.disableRequestLogging) { done(); return; }
  const fields: Record<string, unknown> = {
    request_id: request.requestId,
    method: request.method,
    path: request.url.split('?')[0],
    status_code: reply.statusCode,
    duration_ms: Math.round(reply.elapsedTime),
    upstream_service: resolveUpstreamService(request.url),
  };
  if (request.jwtClaims?.sub) fields['user_id'] = request.jwtClaims.sub;
  if (request.apiKeyContext?.keyHash) fields['key_hash'] = request.apiKeyContext.keyHash;
  request.log.info(fields, 'request completed');
  done();
});

app.addHook('onError', (request, reply, error, done) => {
  if (request.routeOptions.config?.disableRequestLogging) { done(); return; }
  const fields: Record<string, unknown> = {
    request_id: request.requestId,
    method: request.method,
    path: request.url.split('?')[0],
    status_code: reply.statusCode,
    duration_ms: Math.round(reply.elapsedTime),
    upstream_service: resolveUpstreamService(request.url),
    error: { name: error.name, message: error.message },
  };
  if (request.jwtClaims?.sub) fields['user_id'] = request.jwtClaims.sub;
  if (request.apiKeyContext?.keyHash) fields['key_hash'] = request.apiKeyContext.keyHash;
  request.log.error(fields, 'request error');
  done();
});

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
await app.register(locationsRoutes, { prefix: '/v1/locations' });

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  log.error(err, 'Failed to start server');
  process.exit(1);
}
