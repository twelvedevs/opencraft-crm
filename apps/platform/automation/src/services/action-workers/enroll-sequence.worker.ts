import { type Job, type Queue } from 'bullmq';
import type { ActionJobData } from '../../queue/index.js';
import type { ExecutionRepository } from '../../repositories/execution.repository.js';
import { resolveParams, type ExecutionContext } from '../field-interpolator.js';

export const ENROLL_SEQUENCE_URL_ENV = 'NURTURING_ENGINE_URL';

export function createEnrollSequenceProcessor(
  repo: ExecutionRepository,
  queue: Queue<ActionJobData>,
  fetchFn: typeof fetch = globalThis.fetch,
): (job: Job<ActionJobData>) => Promise<void> {
  return async (job: Job<ActionJobData>): Promise<void> => {
    const { execution_id, step_id, action_params, exec_ctx, event, active_hours } = job.data;

    await repo.updateStepStatus(step_id, 'running', { attempt: job.attemptsMade + 1 });

    const resolved = resolveParams(action_params, event, exec_ctx as ExecutionContext);

    const nextStepId = resolved['_next_step_id'] as string | undefined;

    const {
      _next_step_id: _,
      _if_true_step_id: _a,
      _if_false_step_id: _b,
      _if_true_subtree_ids: _c,
      _if_false_subtree_ids: _d,
      ...callParams
    } = resolved;

    const baseUrl = process.env[ENROLL_SEQUENCE_URL_ENV];
    if (!baseUrl) {
      throw new Error('NURTURING_ENGINE_URL is not configured');
    }

    const response = await fetchFn(baseUrl + '/sequences/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(callParams),
    });

    if (!response.ok) {
      throw new Error('enroll_sequence HTTP error: ' + response.status);
    }

    await repo.updateStepStatus(step_id, 'completed', { completedAt: new Date() });

    if (nextStepId) {
      const nextStep = await repo.findStepById(nextStepId);
      if (nextStep !== null) {
        await queue.add(nextStep.action_type, {
          execution_id,
          step_id: nextStepId,
          action_type: nextStep.action_type,
          action_params: nextStep.action_params as Record<string, unknown>,
          exec_ctx,
          event,
          active_hours,
        });
      }
    } else {
      await repo.updateExecutionStatus(execution_id, 'completed', new Date());
    }
  };
}
