import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import formbody from '@fastify/formbody';
import { openapiPlugin } from '@ortho/openapi';
import type { Redis } from 'ioredis';
import type { Knex } from './db.js';
import type { EventBus } from '@ortho/event-bus';
import type { TwilioClient } from './services/twilio-client.js';
import { RateLimiter } from './services/rate-limiter.js';
import { healthRoutes } from './routes/health.js';
import { numberRoutes } from './routes/numbers.js';
import { messageRoutes } from './routes/messages.js';
import { optOutRoutes } from './routes/opt-outs.js';
import { webhookRoutes } from './routes/webhooks.js';

export async function buildApp(
  db: Knex,
  eventBus: EventBus,
  redis: Redis,
  twilioClient: TwilioClient,
  statusCallbackUrl: string,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(sensible);
  await app.register(openapiPlugin, {
    title: 'Messaging Service',
    description: 'SMS/MMS/Voice via Twilio',
    tags: [
      { name: 'Messages', description: 'SMS message sending and retrieval' },
      { name: 'Numbers', description: 'Twilio number pool management' },
      { name: 'Opt-outs', description: 'STOP/opt-out handling' },
      { name: 'Webhooks', description: 'Twilio webhook receivers' },
    ],
  });
  await app.register(formbody);

  app.decorate('db', db);
  app.decorate('eventBus', eventBus);
  app.decorate('redis', redis);
  app.decorate('twilioClient', twilioClient);
  app.decorate('statusCallbackUrl', statusCallbackUrl);

  const rateLimiter = new RateLimiter(redis);
  app.decorate('rateLimiter', rateLimiter);

  app.addHook('onReady', async () => {
    await eventBus.start();
    await rateLimiter.init();
  });

  app.addHook('onClose', async () => {
    await eventBus.stop();
  });

  await app.register(healthRoutes);
  await app.register(numberRoutes);
  await app.register(messageRoutes);
  await app.register(optOutRoutes);
  await app.register(webhookRoutes);

  return app;
}
