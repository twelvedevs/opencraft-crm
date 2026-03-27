import { type Job, type Queue } from 'bullmq';
import type { ActionJobData } from '../../queue/index.js';
import type { ExecutionRepository } from '../../repositories/execution.repository.js';
import { resolveParams, type ExecutionContext } from '../field-interpolator.js';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

export const EVENTBRIDGE_BUS_ENV = 'EVENTBRIDGE_BUS_NAME';

export function createEmitEventProcessor(
  repo: ExecutionRepository,
  queue: Queue<ActionJobData>,
  ebClient: EventBridgeClient = new EventBridgeClient({}),
): (job: Job<ActionJobData>) => Promise<void> {
  return async (job: Job<ActionJobData>): Promise<void> => {
    const { execution_id, step_id, action_params, exec_ctx, event } = job.data;

    await repo.updateStepStatus(step_id, 'running', { attempt: job.attemptsMade + 1 });

    const busName = process.env[EVENTBRIDGE_BUS_ENV];
    if (!busName) {
      throw new Error('EVENTBRIDGE_BUS_NAME is not configured');
    }

    const eventType = action_params['event_type'] as string;
    const rawPayload = (action_params['payload'] as Record<string, unknown>) ?? {};
    const resolvedPayload = resolveParams(rawPayload, event, exec_ctx as ExecutionContext);

    await ebClient.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: busName,
            Source: 'automation-engine',
            DetailType: eventType,
            Detail: JSON.stringify(resolvedPayload),
          },
        ],
      }),
    );

    await repo.updateStepStatus(step_id, 'completed', { completedAt: new Date() });

    const nextStepId = action_params['_next_step_id'] as string | undefined;

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
        });
      }
    } else {
      await repo.updateExecutionStatus(execution_id, 'completed', new Date());
    }
  };
}
