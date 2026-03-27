import { type Job, type Queue } from 'bullmq';
import type { ActionJobData } from '../../queue/index.js';
import type { ExecutionRepository } from '../../repositories/execution.repository.js';
import { resolveParams, type ExecutionContext } from '../field-interpolator.js';
import { computeDelay, type ActiveHoursConfig } from '../active-hours.js';

export const TEMPLATE_SERVICE_URL_ENV = 'TEMPLATE_SERVICE_URL';
export const MESSAGING_SERVICE_URL_ENV = 'MESSAGING_SERVICE_URL';

export function createSendMessageProcessor(
  repo: ExecutionRepository,
  queue: Queue<ActionJobData>,
  fetchFn: typeof fetch = globalThis.fetch,
): (job: Job<ActionJobData>) => Promise<void> {
  return async (job: Job<ActionJobData>): Promise<void> => {
    const { execution_id, step_id, action_params, exec_ctx, event, active_hours } = job.data;

    // Step 1: active hours check (before marking 'running')
    if (active_hours !== null && active_hours !== undefined) {
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

    // Step 2: mark running
    await repo.updateStepStatus(step_id, 'running', { attempt: job.attemptsMade + 1 });

    // Step 3: resolve params and extract fields
    const resolved = resolveParams(action_params, event, exec_ctx as ExecutionContext);
    const nextStepId = resolved['_next_step_id'] as string | undefined;
    const templateId = resolved['template_id'] as string;
    const to = resolved['to_field'] as string;
    const from = resolved['from_field'] as string;
    const context = resolved['context'];
    const dedupKey = resolved['dedup_key'] as string | undefined;

    if (!dedupKey) {
      console.warn('send_message: missing dedup_key for step ' + step_id);
    }

    // Step 4: Template Service render
    const templateUrl = process.env[TEMPLATE_SERVICE_URL_ENV];
    if (!templateUrl) {
      throw new Error('TEMPLATE_SERVICE_URL is not configured');
    }

    const tplRes = await fetchFn(templateUrl + '/templates/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_id: templateId, context }),
    });

    if (!tplRes.ok) {
      throw new Error('templates/render error: ' + tplRes.status);
    }

    const { body_text } = (await tplRes.json()) as { body_text: string };

    // Step 5: Messaging Service send
    const msgUrl = process.env[MESSAGING_SERVICE_URL_ENV];
    if (!msgUrl) {
      throw new Error('MESSAGING_SERVICE_URL is not configured');
    }

    const msgPayload: Record<string, unknown> = { to, from, body: body_text };
    if (dedupKey) {
      msgPayload['dedup_key'] = dedupKey;
    }

    const msgRes = await fetchFn(msgUrl + '/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msgPayload),
    });

    if (!msgRes.ok) {
      throw new Error('messages/send error: ' + msgRes.status);
    }

    // Step 6: complete and chain
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
          active_hours: job.data.active_hours,
        });
      }
    } else {
      await repo.updateExecutionStatus(execution_id, 'completed', new Date());
    }
  };
}
