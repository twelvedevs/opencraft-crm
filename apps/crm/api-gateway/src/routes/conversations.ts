import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Route — /v1/conversations/* pass-through proxy to Conversation Service
// ---------------------------------------------------------------------------
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

async function conversationsRoutes(app: FastifyInstance): Promise<void> {
  const handler: Parameters<typeof app.route>[0]['handler'] = async (request, reply) => {
    const upstreamPath = request.url.replace(/^\/v1/, '');
    return reply.from(`${config.CONVERSATION_SERVICE_URL}${upstreamPath}`, {
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

export default conversationsRoutes;
