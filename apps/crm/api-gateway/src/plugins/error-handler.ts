import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyError } from 'fastify';

// ---------------------------------------------------------------------------
// Plugin — centralized error handler
// Normalizes gateway-generated errors to { error: string } shape.
// Network/proxy errors from @fastify/reply-from become 502 responses.
// ---------------------------------------------------------------------------
async function errorHandlerPlugin(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Network timeout or connection refused from @fastify/reply-from
    // These typically manifest as ECONNREFUSED, ETIMEDOUT, or ECONNRESET
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'ERR_UNHANDLED_ERROR' ||
      error.message?.includes('ECONNREFUSED') ||
      error.message?.includes('ETIMEDOUT') ||
      error.message?.includes('connect ECONNREFUSED')
    ) {
      return reply.code(502).send({ error: 'upstream_unavailable' });
    }

    // Fastify HTTP errors (thrown with reply.code(n) or createError)
    if (error.statusCode) {
      return reply.code(error.statusCode).send({ error: error.message });
    }

    // Unknown / unhandled errors
    request.log.error({ err: error }, 'Unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });
}

export default fp(errorHandlerPlugin, {
  name: 'gateway-error-handler',
  fastify: '5.x',
});
