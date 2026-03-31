import type { Knex } from './db.js';
import type { EventBus } from '@ortho/event-bus';
import type { Redis } from 'ioredis';

declare module 'fastify' {
  interface FastifyInstance {
    db: Knex;
    eventBus: EventBus;
    redis: Redis;
  }
}
