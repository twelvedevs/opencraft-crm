import type { Knex } from './db.js';
import type { EventBus } from '@ortho/event-bus';
import type { Queue } from 'bullmq';

declare module 'fastify' {
  interface FastifyInstance {
    db: Knex;
    eventBus: EventBus;
    queues: { transactionalSend: Queue; campaignRecipient: Queue };
  }
}
