import type { Knex } from './db.js';
import type { Redis } from 'ioredis';
import type { SegmentRepository } from './services/segment-repository.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Knex;
    redis: Redis;
    segmentRepository: SegmentRepository;
  }
}
