import { Worker, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { NotificationsRepo } from '../repositories/notifications.repo.js';

const CLEANUP_QUEUE = 'notification-cleanup';
const CLEANUP_JOB_NAME = 'cleanup-expired';
const CLEANUP_CRON = '0 2 * * *';

/**
 * Creates a BullMQ repeatable cleanup worker that deletes expired notifications
 * at 2:00 AM UTC daily. BullMQ deduplicates the repeatable job by its internal
 * repeat key (queue + job name + cron pattern), so registering it from multiple
 * ECS tasks is safe — only one scheduled entry is stored in Redis.
 */
export function createCleanupWorker(redisUrl: string, repo: NotificationsRepo): Worker {
  // BullMQ workers require maxRetriesPerRequest: null for blocking mode
  const workerRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  // Separate connection for Queue (non-blocking operations)
  const queueRedis = new Redis(redisUrl);

  const queue = new Queue(CLEANUP_QUEUE, { connection: queueRedis });

  // Register the repeatable job — BullMQ deduplicates via internal repeat key,
  // so this is idempotent across all ECS task instances.
  queue
    .add(CLEANUP_JOB_NAME, {}, { repeat: { pattern: CLEANUP_CRON } })
    .catch((err: unknown) => {
      console.error('Failed to register cleanup repeatable job:', err);
    });

  const worker = new Worker(
    CLEANUP_QUEUE,
    async () => {
      const count = await repo.deleteExpired();
      console.log(`Cleanup worker: deleted ${count} expired notifications`);
    },
    { connection: workerRedis },
  );

  worker.on('failed', (_job, err) => {
    console.error('Cleanup job failed:', err);
  });

  return worker;
}
