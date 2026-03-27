import { type Job, type Queue } from 'bullmq';
import type { ActionJobData } from '../../queue/index.js';
import type { ExecutionRepository } from '../../repositories/execution.repository.js';
import { resolveParams, type ExecutionContext } from '../field-interpolator.js';

export async function resolveHeaderSecrets(
  headers: Record<string, string>,
  secretsResolver: (key: string) => Promise<string>,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    const match = /^\{\{(\w+)\}\}$/.exec(headerValue);
    if (match) {
      result[headerName] = await secretsResolver(match[1]);
    } else {
      result[headerName] = headerValue;
    }
  }
  return result;
}

export function createCallWebhookProcessor(
  repo: ExecutionRepository,
  queue: Queue<ActionJobData>,
  secretsResolver: (key: string) => Promise<string>,
  fetchFn: typeof fetch = globalThis.fetch,
): (job: Job<ActionJobData>) => Promise<void> {
  return async (job: Job<ActionJobData>): Promise<void> => {
    const { execution_id, step_id, action_params, exec_ctx, event } = job.data;

    // Step 1: mark running
    await repo.updateStepStatus(step_id, 'running', { attempt: job.attemptsMade + 1 });

    // Step 2: resolve params
    const resolved = resolveParams(action_params, event, exec_ctx as ExecutionContext);
    const nextStepId = resolved['_next_step_id'] as string | undefined;
    const url = resolved['url'] as string;
    const method = (resolved['method'] as string | undefined) ?? 'POST';
    const rawHeaders = (resolved['headers'] as Record<string, string> | undefined) ?? {};
    const body = resolved['body'];
    const timeoutMs = (resolved['timeout_ms'] as number | undefined) ?? 5000;

    // Step 3: resolve header secrets
    const resolvedHeaders = await resolveHeaderSecrets(rawHeaders, secretsResolver);

    // Step 4: HTTP call with timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const requestBody = typeof body === 'string' ? body : JSON.stringify(body);

    let webhookRes!: Response;
    try {
      webhookRes = await fetchFn(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...resolvedHeaders },
        body: requestBody,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        await repo.updateStepStatus(step_id, 'failed', { error: 'timeout after ' + timeoutMs + 'ms' });
        await repo.updateExecutionStatus(execution_id, 'failed', new Date());
        return;
      }
      throw err;
    }
    clearTimeout(timer);

    if (!webhookRes.ok) {
      throw new Error('call_webhook error: ' + webhookRes.status);
    }

    // Step 5: complete and chain
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
