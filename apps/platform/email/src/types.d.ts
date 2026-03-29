import type { Knex } from './db.js';
import type { EventBus } from '@ortho/event-bus';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

declare module 'fastify' {
  interface FastifyInstance {
    db: Knex;
    eventBus: EventBus;
    queues: { transactionalSend: Queue; campaignRecipient: Queue };
    redis: Redis;
  }
}
