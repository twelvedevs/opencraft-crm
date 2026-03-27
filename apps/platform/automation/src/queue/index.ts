import { Queue } from 'bullmq';
import type { ExecutionContext } from '../services/field-interpolator.js';
import type { ActiveHoursConfig } from '../services/active-hours.js';

export const QUEUE_NAME = 'automation-actions';

export interface ActionJobData {
  execution_id: string;
  step_id: string;
  action_type: string;
  action_params: Record<string, unknown>;
  exec_ctx: ExecutionContext;
  event: Record<string, unknown>;
  active_hours?: ActiveHoursConfig | null;
}

export function createQueue(connection: object): Queue<ActionJobData> {
  return new Queue<ActionJobData>(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'custom' },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  });
}
