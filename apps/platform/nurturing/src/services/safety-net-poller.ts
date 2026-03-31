import fp from 'fastify-plugin';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import type { StepExecutionsRepository } from '../repositories/step-executions.repo.js';
import type { StepJobData } from '../queue/step-queue.js';
import type { Logger } from 'pino';

export interface SafetyNetPollerDeps {
  stepExecutionsRepo: StepExecutionsRepository;
  stepQueue: Queue<StepJobData>;
  redis: Redis;
  logger: Logger;
}

const LOCK_KEY = 'nurturing:safety-net-poller:lock';
const LOCK_TTL_MS = 240000;

export async function runPollCycle(deps: SafetyNetPollerDeps): Promise<void> {
  const acquired = await deps.redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (acquired !== 'OK') {
    deps.logger.debug('safety-net-poller: lock not acquired, skipping cycle');
    return;
  }

  const steps = await deps.stepExecutionsRepo.findOrphanedPending();
  deps.logger.info({ count: steps.length }, 'safety-net-poller: found orphaned steps');

  for (const step of steps) {
    try {
      const job = await deps.stepQueue.add(
        'execute-step',
        {
          enrollment_id: step.enrollment_id,
          step_execution_id: step.id,
          step_id: step.step_id,
          step_index: step.step_index,
        },
        { delay: 0, jobId: step.id },
      );
      await deps.stepExecutionsRepo.updateJobId(step.id, job.id!);
      deps.logger.info({ step_id: step.id }, 'safety-net-poller: re-enqueued orphaned step');
    } catch (err) {
      deps.logger.error({ err, step_id: step.id }, 'safety-net-poller: failed to re-enqueue step');
    }
  }
}

export default fp(
  async function safetyNetPollerPlugin(fastify, opts: SafetyNetPollerDeps) {
    const timer = setInterval(() => {
      void runPollCycle(opts).catch((err) =>
        fastify.log.error(err, 'safety-net-poller: poll cycle error'),
      );
    }, 5 * 60 * 1000);

    fastify.addHook('onClose', async () => {
      clearInterval(timer);
    });
  },
  { name: 'safety-net-poller' },
);
