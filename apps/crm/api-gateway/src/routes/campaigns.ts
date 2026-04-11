import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Route — /v1/campaigns/* pass-through proxy to Campaign Service
// ---------------------------------------------------------------------------
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

async function campaignsRoutes(app: FastifyInstance): Promise<void> {
  app.route({
    method: HTTP_METHODS,
    url: '/*',
    handler: async (request, reply) => {
      const upstreamPath = request.url.replace(/^\/v1/, '');
      return reply.from(`${config.CAMPAIGN_SERVICE_URL}${upstreamPath}`, {
        rewriteRequestHeaders: (_req, headers) => ({
          ...headers,
          ...request.authHeaders,
          'x-request-id': request.requestId,
        }),
      });
    },
  });
}

export default campaignsRoutes;
