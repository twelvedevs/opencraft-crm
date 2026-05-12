import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

export async function healthRoutes(
  app: FastifyInstance,
  opts: { pool: Pool },
): Promise<void> {
  app.get('/health', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async (_req, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  app.get('/ready', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async (_req, reply) => {
    try {
      await opts.pool.query('SELECT 1');
      return reply.status(200).send({ status: 'ready' });
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : 'unknown';
      return reply.status(503).send({ status: 'unavailable', reason });
    }
  });
}
