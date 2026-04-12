import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Knex } from './db.js';
import type { EventBus } from '@ortho/event-bus';
import { openapiPlugin } from '@ortho/openapi';
import { healthRoutes } from './routes/health.js';
import { domainRoutes } from './routes/domains.js';
import { sendRoutes } from './routes/sends.js';
import { spamCheckRoutes } from './routes/spam-check.js';
import { campaignRoutes } from './routes/campaigns.js';
import { webhookRoutes } from './routes/webhooks.js';

export async function buildApp(
  db: Knex,
  eventBus: EventBus,
  queues: { transactionalSend: Queue; campaignRecipient: Queue },
  redis: Redis,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(sensible);

  await app.register(openapiPlugin, {
    title: 'Email Service',
    description: 'Email delivery via SendGrid',
    tags: [
      { name: 'Sends', description: 'Transactional email sending' },
      { name: 'Bulk Campaigns', description: 'Bulk email campaign delivery' },
      { name: 'Domains', description: 'Dedicated sending domain management' },
      { name: 'Spam Check', description: 'Email spam score checking' },
      { name: 'Webhooks', description: 'SendGrid event webhooks' },
    ],
  });

  app.decorate('db', db);
  app.decorate('eventBus', eventBus);
  app.decorate('queues', queues);
  app.decorate('redis', redis);

  app.addHook('onReady', async () => {
    await eventBus.start();
  });

  app.addHook('onClose', async () => {
    await eventBus.stop();
    await queues.transactionalSend.close();
    await queues.campaignRecipient.close();
  });

  await app.register(healthRoutes);
  await app.register(domainRoutes, { prefix: '/emails' });
  await app.register(sendRoutes, { prefix: '/emails' });
  await app.register(spamCheckRoutes, { prefix: '/emails' });
  await app.register(campaignRoutes, { prefix: '/emails' });
  await app.register(webhookRoutes);

  return app;
}
