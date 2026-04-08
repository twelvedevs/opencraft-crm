import { Redis } from 'ioredis';
import { env } from '../env.js';

export const bullmqRedis = new Redis(env.BULLMQ_REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const ORCHESTRATE_QUEUE = 'campaign:orchestrate';
export const AB_WINNER_QUEUE = 'campaign:ab-winner-select';
