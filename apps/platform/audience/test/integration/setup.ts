import knex, { type Knex } from 'knex';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';

export const DB_URL = process.env['DATABASE_URL'];
export const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

export function createTestDb(): Knex {
  return knex({
    client: 'pg',
    connection: DB_URL!,
  });
}

export async function runMigrations(db: Knex): Promise<void> {
  await db.migrate.latest({
    directory: new URL('../../migrations', import.meta.url).pathname,
    loadExtensions: ['.ts'],
  });
}

export async function truncateTables(db: Knex): Promise<void> {
  await db.raw(
    'TRUNCATE audience_segments, audience_segment_versions, audience_snapshots, audience_snapshot_members CASCADE',
  );
}

export interface TestContext {
  app: FastifyInstance;
  db: Knex;
  redis: Redis;
  cleanupQueue: Queue;
  close: () => Promise<void>;
}

export async function setupTestApp(): Promise<TestContext> {
  const db = createTestDb();
  await runMigrations(db);

  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  const cleanupQueue = new Queue('audience-snapshot-cleanup-test', { connection: redis });

  const app = await buildApp(db, redis, cleanupQueue);
  await app.ready();

  return {
    app,
    db,
    redis,
    cleanupQueue,
    async close() {
      await app.close();
      await db.destroy();
    },
  };
}
