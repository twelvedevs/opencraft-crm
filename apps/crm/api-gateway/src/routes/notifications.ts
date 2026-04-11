import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Route — /v1/notifications/*
// GET /v1/notifications/stream: SSE proxy (no timeout, streaming, no buffering)
// All other routes: standard buffered proxy with UPSTREAM_TIMEOUT_MS
// ---------------------------------------------------------------------------

async function notificationsRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /notifications/stream — SSE proxy (long-lived, no timeout)
  // -------------------------------------------------------------------------
  app.route({
    method: 'GET',
    url: '/stream',
    handler: async (request, reply) => {
      // Set SSE response headers before proxying
      void reply.headers({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      });

      return reply.from(`${config.NOTIFICATION_SERVICE_URL}/notifications/stream`, {
        rewriteRequestHeaders: (_req, headers) => {
          const forwardHeaders: Record<string, string | string[] | undefined> = {
            ...headers,
            ...request.authHeaders,
            'x-request-id': request.requestId,
          };
          // Forward Last-Event-ID if client sent it for reconnection
          const lastEventId = request.headers['last-event-id'];
          if (lastEventId) {
            forwardHeaders['last-event-id'] = lastEventId;
          }
          return forwardHeaders;
        },
      });
    },
  });

  // -------------------------------------------------------------------------
  // GET /notifications — list notifications (standard buffered)
  // -------------------------------------------------------------------------
  app.route({
    method: 'GET',
    url: '/',
    handler: async (request, reply) => {
      return reply.from(`${config.NOTIFICATION_SERVICE_URL}/notifications`, {
        rewriteRequestHeaders: (_req, headers) => ({
          ...headers,
          ...request.authHeaders,
          'x-request-id': request.requestId,
        }),
      });
    },
  });

  // -------------------------------------------------------------------------
  // POST /notifications/:id/read — mark one notification read
  // -------------------------------------------------------------------------
  app.route({
    method: 'POST',
    url: '/:id/read',
    handler: async (request, reply) => {
      const upstreamPath = request.url.replace(/^\/v1/, '');
      return reply.from(`${config.NOTIFICATION_SERVICE_URL}${upstreamPath}`, {
        rewriteRequestHeaders: (_req, headers) => ({
          ...headers,
          ...request.authHeaders,
          'x-request-id': request.requestId,
        }),
      });
    },
  });

  // -------------------------------------------------------------------------
  // POST /notifications/read-all — mark all notifications read
  // -------------------------------------------------------------------------
  app.route({
    method: 'POST',
    url: '/read-all',
    handler: async (request, reply) => {
      return reply.from(`${config.NOTIFICATION_SERVICE_URL}/notifications/read-all`, {
        rewriteRequestHeaders: (_req, headers) => ({
          ...headers,
          ...request.authHeaders,
          'x-request-id': request.requestId,
        }),
      });
    },
  });
}

export default fp(notificationsRoutes, {
  name: 'notifications-routes',
  fastify: '5.x',
});
