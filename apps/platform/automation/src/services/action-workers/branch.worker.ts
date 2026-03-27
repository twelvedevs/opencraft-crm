import { type Job, type Queue } from 'bullmq';
import type { ActionJobData } from '../../queue/index.js';
import type { ExecutionRepository } from '../../repositories/execution.repository.js';
import { type Condition, evaluate } from '../condition-evaluator.js';

export function createBranchProcessor(
  repo: ExecutionRepository,
  queue: Queue<ActionJobData>,
): (job: Job<ActionJobData>) => Promise<void> {
  return async (job: Job<ActionJobData>): Promise<void> => {
    const { execution_id, step_id, action_params, exec_ctx, event } = job.data;

    await repo.updateStepStatus(step_id, 'running', { attempt: job.attemptsMade + 1 });

    const condition = action_params['condition'] as Condition;
    const _if_true_step_id = action_params['_if_true_step_id'] as string;
    const _if_false_step_id = action_params['_if_false_step_id'] as string;
    const _if_true_subtree_ids = action_params['_if_true_subtree_ids'] as string[];
    const _if_false_subtree_ids = action_params['_if_false_subtree_ids'] as string[];

    const result = evaluate(condition, event, exec_ctx);

    const winnerStepId = result ? _if_true_step_id : _if_false_step_id;
    const losingIds = result ? _if_false_subtree_ids : _if_true_subtree_ids;

    await repo.updateManyStepsStatus(losingIds, 'skipped');

    const winnerStep = await repo.findStepById(winnerStepId);
    if (winnerStep === null) {
      throw new Error('Branch winner step not found: ' + winnerStepId);
    }

    await queue.add(winnerStep.action_type, {
      execution_id,
      step_id: winnerStepId,
      action_type: winnerStep.action_type,
      action_params: winnerStep.action_params as Record<string, unknown>,
      exec_ctx,
      event,
    });

    await repo.updateStepStatus(step_id, 'completed', { completedAt: new Date() });
  };
}
