import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Knex } from 'knex';
import { env } from '../env.js';
import { findAllActive, type ReportSchedule } from '../repositories/schedules.js';

const QUEUE_NAME = 'reporting-jobs';

function buildJobId(scheduleId: string): string {
  return `report-schedule:${scheduleId}`;
}

function deriveCron(schedule: ReportSchedule): string {
  const { frequency, hour_utc, day_of_week, day_of_month } = schedule;
  if (frequency === 'daily') {
    return `0 ${hour_utc} * * *`;
  }
  if (frequency === 'weekly') {
    return `0 ${hour_utc} * * ${day_of_week ?? 0}`;
  }
  // monthly
  return `0 ${hour_utc} ${day_of_month ?? 1} * *`;
}

export const queueRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
export const reportingQueue = new Queue(QUEUE_NAME, { connection: queueRedis });

export async function registerSchedule(schedule: ReportSchedule): Promise<void> {
  const jobId = buildJobId(schedule.id);
  // Per spec Section 7.2: the repeatable job is a lightweight dispatcher.
  // It carries only the schedule_id so the handler can load the schedule at
  // fire time, check active status, create the report_run row, and enqueue
  // the one-off 'generate-report' job with the newly minted run ID.
  await reportingQueue.add(
    'fire-scheduled-report',
    { schedule_id: schedule.id },
    {
      repeat: { pattern: deriveCron(schedule) },
      jobId,
    },
  );
}

export async function removeSchedule(scheduleId: string): Promise<void> {
  const jobId = buildJobId(scheduleId);
  const repeatableJobs = await reportingQueue.getRepeatableJobs();
  const job = repeatableJobs.find((j) => j.id === jobId);
  if (job) {
    await reportingQueue.removeRepeatableByKey(job.key);
  }
}

export async function replaceSchedule(
  scheduleId: string,
  newSchedule: ReportSchedule,
): Promise<void> {
  await removeSchedule(scheduleId);
  await registerSchedule(newSchedule);
}

export async function reconcile(db: Knex): Promise<void> {
  const [activeSchedules, repeatableJobs] = await Promise.all([
    findAllActive(db),
    reportingQueue.getRepeatableJobs(),
  ]);

  const registeredIds = new Set(repeatableJobs.map((j) => j.id).filter(Boolean));

  for (const schedule of activeSchedules) {
    const jobId = buildJobId(schedule.id);
    if (!registeredIds.has(jobId)) {
      await registerSchedule(schedule);
    }
  }
}
