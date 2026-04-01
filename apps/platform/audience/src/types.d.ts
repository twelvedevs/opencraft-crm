import type { Knex } from './db.js';
import type { Redis } from 'ioredis';

declare module 'fastify' {
  interface FastifyInstance {
    db: Knex;
    redis: Redis;
  }
}
