import { type FastifyInstance } from 'fastify';
import db from '../db.js';
import { queueRedis } from '../services/schedule-manager.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async () => ({ status: 'ok' }));

  app.get('/ready', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async (_req, reply) => {
    let dbOk = false;
    let redisOk = false;

    await Promise.allSettled([
      db.raw('SELECT 1').then(() => {
        dbOk = true;
      }),
      queueRedis.ping().then(() => {
        redisOk = true;
      }),
    ]);

    if (dbOk && redisOk) {
      return reply.code(200).send({ status: 'ok' });
    }
    return reply.code(503).send({
      status: 'unavailable',
      checks: {
        db: dbOk ? 'ok' : 'fail',
        redis: redisOk ? 'ok' : 'fail',
      },
    });
  });
}
