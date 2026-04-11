import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Route — /v1/reports/* pass-through proxy to Reporting Service
// ---------------------------------------------------------------------------
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

async function reportsRoutes(app: FastifyInstance): Promise<void> {
  app.route({
    method: HTTP_METHODS,
    url: '/*',
    handler: async (request, reply) => {
      const upstreamPath = request.url.replace(/^\/v1/, '');
      return reply.from(`${config.REPORTING_SERVICE_URL}${upstreamPath}`, {
        rewriteRequestHeaders: (_req, headers) => ({
          ...headers,
          ...request.authHeaders,
          'x-request-id': request.requestId,
        }),
      });
    },
  });
}

export default fp(reportsRoutes, {
  name: 'reports-routes',
  fastify: '5.x',
});
