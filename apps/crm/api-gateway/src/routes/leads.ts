import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Route — /v1/leads/* pass-through proxy to Lead Service
// ---------------------------------------------------------------------------
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

async function leadsRoutes(app: FastifyInstance): Promise<void> {
  const handler: Parameters<typeof app.route>[0]['handler'] = async (request, reply) => {
    const upstreamPath = request.url.replace(/^\/v1/, '');
    return reply.from(`${config.LEAD_SERVICE_URL}${upstreamPath}`, {
      rewriteRequestHeaders: (_req, headers) => ({
        ...headers,
        ...request.authHeaders,
        'x-request-id': request.requestId,
      }),
    });
  };
  for (const url of ['/', '/*']) {
    app.route({ method: HTTP_METHODS, url, handler });
  }
}

export default leadsRoutes;
