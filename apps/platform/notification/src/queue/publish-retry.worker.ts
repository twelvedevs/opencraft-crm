import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { PublishRetryJobData } from '../services/publisher.js';

const PUBLISH_RETRY_QUEUE = 'publish-retry';

/**
 * Creates a BullMQ Worker that retries Redis PUBLISH after failure.
 * Uses a dedicated ioredis connection (maxRetriesPerRequest: null) for the
 * BullMQ blocking operations, and a separate connection for the PUBLISH command.
 */
export function createPublishRetryWorker(redisUrl: string): Worker<PublishRetryJobData> {
  // BullMQ workers require maxRetriesPerRequest: null for blocking mode
  const workerRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  // Separate connection for non-blocking PUBLISH
  const publishRedis = new Redis(redisUrl);

  const worker = new Worker<PublishRetryJobData>(
    PUBLISH_RETRY_QUEUE,
    async (job) => {
      const { notification_id, channel, seq, title, body, payload, created_at } = job.data;
      const redisKey = `notif:channel:${channel}`;
      const redisPayload = JSON.stringify({
        notification_id,
        seq,
        channel,
        title,
        body: body ?? null,
        payload: payload ?? null,
        created_at,
      });
      await publishRedis.publish(redisKey, redisPayload);
    },
    {
      connection: workerRedis,
    },
  );

  worker.on('failed', (job, err) => {
    const id = job?.data.notification_id ?? 'unknown';
    console.error(`publish-retry job failed for notification ${id}:`, err);
  });

  return worker;
}
