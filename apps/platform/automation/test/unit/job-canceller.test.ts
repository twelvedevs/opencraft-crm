import { describe, it, expect, vi } from 'vitest';
import { JobCanceller } from '../../src/services/job-canceller.js';
import type { Queue } from 'bullmq';
import type { ActionJobData } from '../../src/queue/index.js';

function makeDelayedJob(ruleId: string, extra: Record<string, unknown> = {}) {
  return {
    data: {
      execution_id: 'exec-1',
      step_id: 'step-1',
      action_type: 'send_message',
      action_params: {},
      exec_ctx: { rule_id: ruleId, ...extra },
      event: {},
      active_hours: null,
    } as ActionJobData,
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

function makeQueue(delayed: ReturnType<typeof makeDelayedJob>[]): Queue<ActionJobData> {
  return {
    getDelayed: vi.fn().mockResolvedValue(delayed),
  } as unknown as Queue<ActionJobData>;
}

describe('JobCanceller', () => {
  it('cancels only matching delayed jobs and returns correct count', async () => {
    const job1 = makeDelayedJob('rule-1');
    const job2 = makeDelayedJob('rule-1');
    const job3 = makeDelayedJob('rule-2');
    const job4 = makeDelayedJob('rule-2');

    const queue = makeQueue([job1, job2, job3, job4]);
    const canceller = new JobCanceller(queue);

    const count = await canceller.cancelDelayedJobsForRule('rule-1');

    expect(count).toBe(2);
    expect(job1.remove).toHaveBeenCalledOnce();
    expect(job2.remove).toHaveBeenCalledOnce();
    expect(job3.remove).not.toHaveBeenCalled();
    expect(job4.remove).not.toHaveBeenCalled();
  });

  it('returns 0 and calls no remove when no matching delayed jobs', async () => {
    const job1 = makeDelayedJob('rule-2');
    const job2 = makeDelayedJob('rule-3');

    const queue = makeQueue([job1, job2]);
    const canceller = new JobCanceller(queue);

    const count = await canceller.cancelDelayedJobsForRule('rule-1');

    expect(count).toBe(0);
    expect(job1.remove).not.toHaveBeenCalled();
    expect(job2.remove).not.toHaveBeenCalled();
  });

  it('returns 0 immediately when delayed queue is empty', async () => {
    const queue = makeQueue([]);
    const canceller = new JobCanceller(queue);

    const count = await canceller.cancelDelayedJobsForRule('rule-1');

    expect(count).toBe(0);
  });
});
