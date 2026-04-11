import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Route — /v1/imports/*
// POST /v1/imports/upload uses an extended body size limit (IMPORT_MAX_BODY_SIZE_BYTES).
// All other routes use the global default (MAX_BODY_SIZE_BYTES).
// ---------------------------------------------------------------------------
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

async function importsRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // POST /imports/upload — extended body size
  // -------------------------------------------------------------------------
  app.route({
    method: 'POST',
    url: '/upload',
    bodyLimit: config.IMPORT_MAX_BODY_SIZE_BYTES,
    handler: async (request, reply) => {
      return reply.from(`${config.IMPORT_SERVICE_URL}/imports/upload`, {
        rewriteRequestHeaders: (_req, headers) => ({
          ...headers,
          ...request.authHeaders,
          'x-request-id': request.requestId,
        }),
      });
    },
  });

  // -------------------------------------------------------------------------
  // All other /imports/* routes — standard body limit, simple pass-through
  // -------------------------------------------------------------------------
  app.route({
    method: HTTP_METHODS,
    url: '/*',
    handler: async (request, reply) => {
      const upstreamPath = request.url.replace(/^\/v1/, '');
      return reply.from(`${config.IMPORT_SERVICE_URL}${upstreamPath}`, {
        rewriteRequestHeaders: (_req, headers) => ({
          ...headers,
          ...request.authHeaders,
          'x-request-id': request.requestId,
        }),
      });
    },
  });
}

export default fp(importsRoutes, {
  name: 'imports-routes',
  fastify: '5.x',
});
