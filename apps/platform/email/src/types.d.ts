import type { Knex } from './db.js';
import type { EventBus } from '@ortho/event-bus';

declare module 'fastify' {
  interface FastifyInstance {
    db: Knex;
    eventBus: EventBus;
  }
}
