import { env } from './env.js';
import { createDb } from './db.js';
import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { createSnapshotCleanupQueue, createSnapshotCleanupWorker } from './services/snapshot-cleanup.js';
import { createCleanupSweepWorker } from './services/snapshot-cleanup-sweep.js';

const db = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const cleanupQueue = createSnapshotCleanupQueue(redis);
const cleanupWorker = createSnapshotCleanupWorker(redis, db);
const sweepWorker = createCleanupSweepWorker(redis, db);

const app = await buildApp(db, redis, cleanupQueue);

await app.listen({ port: env.PORT, host: '0.0.0.0' });

// Start workers after app is listening
await cleanupWorker.run();
await sweepWorker.run();

process.on('SIGTERM', async () => {
  await cleanupWorker.close();
  await sweepWorker.close();
  await app.close();
  await db.destroy();
  await redis.disconnect();
  process.exit(0);
});
