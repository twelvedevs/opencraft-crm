import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { Queue } from 'bullmq';
import type { Knex } from './db.js';
import type { EventBus } from '@ortho/event-bus';
import { healthRoutes } from './routes/health.js';
import { domainRoutes } from './routes/domains.js';
import { sendRoutes } from './routes/sends.js';

export async function buildApp(
  db: Knex,
  eventBus: EventBus,
  queues: { transactionalSend: Queue },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(sensible);

  app.decorate('db', db);
  app.decorate('eventBus', eventBus);
  app.decorate('queues', queues);

  app.addHook('onReady', async () => {
    await eventBus.start();
  });

  app.addHook('onClose', async () => {
    await eventBus.stop();
    await queues.transactionalSend.close();
  });

  await app.register(healthRoutes);
  await app.register(domainRoutes, { prefix: '/emails' });
  await app.register(sendRoutes, { prefix: '/emails' });

  return app;
}
