import { type Job, type Queue } from 'bullmq';
import type { ActionJobData } from '../../queue/index.js';
import type { ExecutionRepository } from '../../repositories/execution.repository.js';
import { resolveParams, type ExecutionContext } from '../field-interpolator.js';
import { computeDelay, type ActiveHoursConfig } from '../active-hours.js';

export const AI_SERVICE_URL_ENV = 'AI_SERVICE_URL';
export const MESSAGING_SERVICE_URL_ENV = 'MESSAGING_SERVICE_URL';

export function createCallAiProcessor(
  repo: ExecutionRepository,
  queue: Queue<ActionJobData>,
  fetchFn: typeof fetch = globalThis.fetch,
): (job: Job<ActionJobData>) => Promise<void> {
  return async (job: Job<ActionJobData>): Promise<void> => {
    const { execution_id, step_id, action_params, exec_ctx, event, active_hours } = job.data;

    // Step 1: mark running
    await repo.updateStepStatus(step_id, 'running', { attempt: job.attemptsMade + 1 });

    // Step 2: resolve params
    const resolved = resolveParams(action_params, event, exec_ctx as ExecutionContext);
    const nextStepId = resolved['_next_step_id'] as string | undefined;
    const promptId = resolved['prompt_id'] as string;
    const context = resolved['context'];
    const model = resolved['model'] as string | undefined;
    const dedupKey = resolved['dedup_key'] as string | undefined;
    const autoSend = resolved['auto_send'] === true;
    const autoSendRespectsActiveHours = resolved['auto_send_respects_active_hours'] === true;
    const to = resolved['to_field'] as string | undefined;
    const from = resolved['from_field'] as string | undefined;

    // Step 3: call AI Service
    const aiUrl = process.env[AI_SERVICE_URL_ENV];
    if (!aiUrl) {
      throw new Error('AI_SERVICE_URL is not configured');
    }

    const aiPayload: Record<string, unknown> = { prompt_id: promptId, context };
    if (model !== undefined) {
      aiPayload['model'] = model;
    }
    if (dedupKey !== undefined) {
      aiPayload['dedup_key'] = dedupKey;
    }

    const aiRes = await fetchFn(aiUrl + '/ai/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(aiPayload),
    });

    if (!aiRes.ok) {
      throw new Error('ai/complete error: ' + aiRes.status);
    }

    const { ai_draft } = (await aiRes.json()) as { ai_draft: string };

    // Step 4a: auto_send: false
    if (!autoSend) {
      await repo.updateStepStatus(step_id, 'completed', { completedAt: new Date(), output: { ai_draft } });

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
            active_hours: job.data.active_hours,
          });
        }
      } else {
        await repo.updateExecutionStatus(execution_id, 'completed', new Date());
      }
      return;
    }

    // Step 4b: auto_send: true — active hours check (after AI call)
    if (autoSendRespectsActiveHours && active_hours != null && active_hours !== undefined) {
      const delay = computeDelay(
        active_hours as ActiveHoursConfig,
        event as Record<string, unknown>,
        exec_ctx as ExecutionContext,
      );
      if (delay > 0) {
        await job.moveToDelayed(Date.now() + delay, job.token);
        return;
      }
    }

    // Step 4c: auto_send: true — send phase
    const msgUrl = process.env[MESSAGING_SERVICE_URL_ENV];
    if (!msgUrl) {
      throw new Error('MESSAGING_SERVICE_URL is not configured');
    }

    const autoSendDedupKey = (exec_ctx as ExecutionContext).event_id + '-ai-autosend';
    const msgPayload: Record<string, unknown> = { to, from, body: ai_draft, dedup_key: autoSendDedupKey };

    const msgRes = await fetchFn(msgUrl + '/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msgPayload),
    });

    if (!msgRes.ok) {
      throw new Error('messages/send error: ' + msgRes.status);
    }

    await repo.updateStepStatus(step_id, 'completed', { completedAt: new Date(), output: { ai_draft } });

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
          active_hours: job.data.active_hours,
        });
      }
    } else {
      await repo.updateExecutionStatus(execution_id, 'completed', new Date());
    }
  };
}
