import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import type { Knex } from './db.js';
import type { EventBus } from '@ortho/event-bus';
import type { TwilioClient } from './services/twilio-client.js';
import { RateLimiter } from './services/rate-limiter.js';
import { healthRoutes } from './routes/health.js';
import { numberRoutes } from './routes/numbers.js';
import { messageRoutes } from './routes/messages.js';
import { optOutRoutes } from './routes/opt-outs.js';

export async function buildApp(
  db: Knex,
  eventBus: EventBus,
  redis: Redis,
  twilioClient: TwilioClient,
  statusCallbackUrl: string,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(sensible);

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

  return app;
}
