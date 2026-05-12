import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Route — GET /health
// No auth, no rate limiting. Used by ECS Fargate target group health checks.
// ---------------------------------------------------------------------------
async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', {
    config: { auth: false, skipRateLimit: true, disableRequestLogging: true },
    handler: async (_request, reply) => {
      return reply.code(200).send({ status: 'ok' });
    },
  });
}

export default healthRoutes;
