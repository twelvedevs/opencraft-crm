import { Queue } from 'bullmq';
import type { StepExecutionsRepository } from '../repositories/step-executions.repo.js';
import type { StepJobData } from '../queue/step-queue.js';
import type { Logger } from 'pino';

export interface StartupScannerDeps {
  stepExecutionsRepo: StepExecutionsRepository;
  stepQueue: Queue<StepJobData>;
  logger: Logger;
}

export async function runStartupScan(deps: StartupScannerDeps): Promise<void> {
  const steps = await deps.stepExecutionsRepo.findNullJobIdPending();
  deps.logger.info({ count: steps.length }, 'startup-scanner: found null-job-id pending steps');

  if (steps.length === 0) return;

  for (const step of steps) {
    try {
      const delayMs = Math.max(0, new Date(step.scheduled_at).getTime() - Date.now());
      const job = await deps.stepQueue.add(
        'execute-step',
        {
          enrollment_id: step.enrollment_id,
          step_execution_id: step.id,
          step_id: step.step_id,
          step_index: step.step_index,
        },
        { delay: delayMs, jobId: step.id },
      );
      await deps.stepExecutionsRepo.updateJobId(step.id, job.id!);
      deps.logger.info(
        { step_id: step.id, job_id: job.id, delay_ms: delayMs },
        'startup-scanner: re-enqueued step',
      );
    } catch (err) {
      deps.logger.error({ err, step_id: step.id }, 'startup-scanner: failed to re-enqueue step');
    }
  }

  deps.logger.info({ count: steps.length }, 'startup-scanner: recovery complete');
}
