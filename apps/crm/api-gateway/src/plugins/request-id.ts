import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Extend FastifyRequest to expose the generated requestId
// ---------------------------------------------------------------------------
declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

// ---------------------------------------------------------------------------
// Plugin — generates a fresh UUID v4 for every request.
// Discards any client-supplied X-Request-ID to prevent spoofing.
// Forwarding the generated ID to upstreams is handled by route plugins via
// @fastify/reply-from rewriteRequestHeaders.
// ---------------------------------------------------------------------------
async function requestIdPlugin(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request) => {
    // Discard any client-supplied value
    delete request.headers['x-request-id'];

    // Generate a fresh, unforgeable request ID
    request.requestId = crypto.randomUUID();
  });
}

export default fp(requestIdPlugin, {
  name: 'request-id',
  fastify: '5.x',
});
