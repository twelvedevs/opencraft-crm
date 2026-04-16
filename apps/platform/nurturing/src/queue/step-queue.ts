import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export type StepJobData = {
  enrollment_id: string;
  step_execution_id: string;
  step_id: string;
  step_index: number;
};

export function createStepQueue(redisUrl: string): Queue<StepJobData> {
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  return new Queue<StepJobData>('nurturing-step-execution', { connection });
}
