import type { Queue } from 'bullmq';
import type { ActionJobData } from '../queue/index.js';

export class JobCanceller {
  constructor(private readonly queue: Queue<ActionJobData>) {}

  async cancelDelayedJobsForRule(ruleId: string): Promise<number> {
    const delayed = await this.queue.getDelayed();
    const toCancel = delayed.filter((j) => j.data.exec_ctx.rule_id === ruleId);
    await Promise.all(toCancel.map((j) => j.remove()));
    return toCancel.length;
  }
}
