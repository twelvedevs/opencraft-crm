import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Route — /v1/leads/* pass-through proxy to Lead Service
// ---------------------------------------------------------------------------
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

async function leadsRoutes(app: FastifyInstance): Promise<void> {
  app.route({
    method: HTTP_METHODS,
    url: '/*',
    handler: async (request, reply) => {
      // Strip the /v1 prefix before forwarding (request.url contains the full path)
      const upstreamPath = request.url.replace(/^\/v1/, '');
      return reply.from(`${config.LEAD_SERVICE_URL}${upstreamPath}`, {
        rewriteRequestHeaders: (_req, headers) => ({
          ...headers,
          ...request.authHeaders,
          'x-request-id': request.requestId,
        }),
      });
    },
  });
}

export default fp(leadsRoutes, {
  name: 'leads-routes',
  fastify: '5.x',
});
