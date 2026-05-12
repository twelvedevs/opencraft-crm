import type { Knex } from './db.js';
import type { EventBus } from '@ortho/event-bus';
import type { Redis } from 'ioredis';
import type { TwilioClient } from './services/twilio-client.js';
import type { RateLimiter } from './services/rate-limiter.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Knex;
    eventBus: EventBus;
    redis: Redis;
    twilioClient: TwilioClient;
    rateLimiter: RateLimiter;
    statusCallbackUrl: string;
  }
}
