import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export function createConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

export function createQueues(connection: Redis): { transactionalSend: Queue; campaignRecipient: Queue } {
  return {
    transactionalSend: new Queue('transactional-send', { connection }),
    campaignRecipient: new Queue('campaign-recipient', { connection }),
  };
}
