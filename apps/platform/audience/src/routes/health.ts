import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async (_req, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });
}
