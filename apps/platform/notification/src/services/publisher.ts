import { randomUUID } from 'crypto';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { NotificationsRepo } from '../repositories/notifications.repo.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const PUBLISH_RETRY_QUEUE = 'publish-retry';

export interface PublishInput {
  channel: string;
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
}

export interface PublishRetryJobData {
  notification_id: string;
  channel: string;
  seq: string;
  title: string;
  body?: string;
  payload?: Record<string, unknown> | null;
  created_at: string;
}

export class Publisher {
  private readonly retryQueue: Queue<PublishRetryJobData>;

  constructor(
    private readonly repo: NotificationsRepo,
    private readonly redis: Redis,
  ) {
    this.retryQueue = new Queue<PublishRetryJobData>(PUBLISH_RETRY_QUEUE, {
      connection: redis,
    });
  }

  async publish(input: PublishInput): Promise<{ notification_id: string }> {
    const id = randomUUID();
    const expires_at = new Date(Date.now() + SEVEN_DAYS_MS);

    const { id: notification_id, seq } = await this.repo.insert({
      id,
      channel: input.channel,
      title: input.title,
      body: input.body,
      payload: input.payload,
      expires_at,
    });

    const created_at = new Date().toISOString();
    const redisKey = `notif:channel:${input.channel}`;
    const redisPayload = JSON.stringify({
      notification_id,
      seq,
      channel: input.channel,
      title: input.title,
      body: input.body ?? null,
      payload: input.payload ?? null,
      created_at,
    });

    try {
      await this.redis.publish(redisKey, redisPayload);
    } catch {
      const jobData: PublishRetryJobData = {
        notification_id,
        channel: input.channel,
        seq,
        title: input.title,
        body: input.body,
        payload: input.payload ?? null,
        created_at,
      };
      await this.retryQueue.add('retry', jobData, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      });
    }

    return { notification_id };
  }
}
