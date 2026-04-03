import { Worker, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { pruneExpiredAndOldRevoked } from '../repositories/refresh-token.repo.js';

const CLEANUP_QUEUE = 'identity-cleanup';
const CLEANUP_JOB_NAME = 'prune-refresh-tokens';
const CLEANUP_CRON = '0 3 * * *';

/**
 * Registers a BullMQ repeatable job that prunes expired and old revoked
 * refresh tokens at 03:00 UTC daily. BullMQ deduplicates the repeatable
 * job by its internal repeat key, so registering from multiple ECS tasks
 * is safe.
 */
export function registerCleanupJob(
  redisUrl: string,
  pool: Pool,
): { worker: Worker; queue: Queue } {
  const workerRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queueRedis = new Redis(redisUrl);

  const queue = new Queue(CLEANUP_QUEUE, { connection: queueRedis });

  queue
    .add(CLEANUP_JOB_NAME, {}, { repeat: { pattern: CLEANUP_CRON } })
    .catch((err: unknown) => {
      console.error('Failed to register identity cleanup repeatable job:', err);
    });

  const worker = new Worker(
    CLEANUP_QUEUE,
    async () => {
      const count = await pruneExpiredAndOldRevoked(pool);
      console.log(`Identity cleanup: pruned ${count} refresh tokens`);
    },
    { connection: workerRedis },
  );

  worker.on('failed', (_job, err) => {
    console.error('Identity cleanup job failed:', err);
  });

  return { worker, queue };
}
