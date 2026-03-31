import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_req, reply) => {
    const checks = { db: false, redis: false };

    try {
      await app.db.raw('SELECT 1');
      checks.db = true;
    } catch {
      // db check failed
    }

    try {
      const pong = await app.redis.ping();
      checks.redis = pong === 'PONG';
    } catch {
      // redis check failed
    }

    const allOk = checks.db && checks.redis;
    return reply
      .status(allOk ? 200 : 503)
      .send({ status: allOk ? 'ok' : 'error', checks });
  });
}
