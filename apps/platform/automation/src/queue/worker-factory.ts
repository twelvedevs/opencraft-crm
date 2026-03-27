import { Worker, type Job } from 'bullmq';
import type { ActionJobData } from './index.js';

export const RETRY_DELAYS: readonly number[] = [5000, 30000, 120000, 600000];

export function createActionWorker(
  queueName: string,
  connection: object,
  processor: (job: Job<ActionJobData>) => Promise<void>,
  logger?: Pick<Console, 'error'>,
): Worker<ActionJobData> {
  const worker = new Worker<ActionJobData>(queueName, processor, {
    connection,
    settings: {
      backoffStrategy: (attemptsMade: number) =>
        RETRY_DELAYS[attemptsMade - 1] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1],
    },
  });

  worker.on('failed', (job: Job<ActionJobData> | undefined, err: Error) => {
    if (!job) return;

    const isFinalFailure = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (isFinalFailure) {
      (logger?.error ?? console.error)(
        JSON.stringify({
          alert: 'automation_dlq',
          queue: queueName,
          execution_id: job.data.execution_id,
          step_id: job.data.step_id,
          action_type: job.data.action_type,
          error: err.message,
        }),
      );
    }
  });

  return worker;
}
