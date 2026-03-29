import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { Knex } from './db.js';
import type { EventBus } from '@ortho/event-bus';
import { healthRoutes } from './routes/health.js';
import { domainRoutes } from './routes/domains.js';

export async function buildApp(db: Knex, eventBus: EventBus): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(sensible);

  app.decorate('db', db);
  app.decorate('eventBus', eventBus);

  app.addHook('onReady', async () => {
    await eventBus.start();
  });

  app.addHook('onClose', async () => {
    await eventBus.stop();
  });

  await app.register(healthRoutes);
  await app.register(domainRoutes, { prefix: '/emails' });

  return app;
}
