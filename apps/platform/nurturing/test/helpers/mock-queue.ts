import { randomUUID } from 'node:crypto';
import type { StepJobData } from '../../src/queue/step-queue.js';
import type { Queue } from 'bullmq';

export interface MockJob {
  name: string;
  data: StepJobData;
  opts?: unknown;
}

export function createMockQueue() {
  const jobs: MockJob[] = [];

  return {
    async add(name: string, data: StepJobData, opts?: unknown): Promise<{ id: string }> {
      jobs.push({ name, data, opts });
      return { id: randomUUID() };
    },
    getMockJobs(): MockJob[] {
      return jobs;
    },
  } as unknown as Queue<StepJobData> & { getMockJobs(): MockJob[] };
}
