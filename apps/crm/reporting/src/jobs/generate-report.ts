import { Worker } from 'bullmq';
import type { Job, JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { createLogger } from '@ortho/logger';
import { env } from '../env.js';
import { renderReport, type GenerateReportJob } from '../services/report-renderer.js';
import { reportingQueue } from '../services/schedule-manager.js';
import db from '../db.js';
import * as runsRepo from '../repositories/runs.js';
import * as schedulesRepo from '../repositories/schedules.js';

export type { GenerateReportJob };

/**
 * Default job options for generate-report jobs.
 * Routes that enqueue jobs should spread these options.
 */
export const GENERATE_REPORT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnFail: false,
};

interface FireScheduledReportJob {
  schedule_id: string;
}

const log = createLogger('crm-reporting:worker');

const workerRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

/**
 * Per spec Section 7.2: lightweight handler for repeatable 'fire-scheduled-report' jobs.
 *
 * Steps:
 *   1. Load schedule from DB
 *   2. Check schedule.active — abort if false (race-condition safety net)
 *   3. Create report_run row (triggered_by='scheduler', status=pending)
 *   4. Enqueue one-off 'generate-report' job with the new run ID
 */
async function handleScheduledFire(job: Job<FireScheduledReportJob>): Promise<void> {
  const { schedule_id } = job.data;
  log.info({ jobId: job.id, scheduleId: schedule_id }, 'Processing fire-scheduled-report job');

  const schedule = await schedulesRepo.findById(db, schedule_id);
  if (!schedule) {
    log.error({ scheduleId: schedule_id }, 'Schedule not found; skipping');
    return;
  }

  if (!schedule.active) {
    log.info({ scheduleId: schedule_id }, 'Schedule is inactive; skipping');
    return;
  }

  const run = await runsRepo.create(db, {
    report_config_id: schedule.report_config_id,
    report_schedule_id: schedule.id,
    triggered_by: 'scheduler',
    format: schedule.format,
    status: 'pending',
    recipient_emails: schedule.recipient_emails,
  });

  await reportingQueue.add(
    'generate-report',
    {
      report_config_id: schedule.report_config_id,
      report_run_id: run.id,
      format: schedule.format as 'pdf' | 'csv',
      recipient_emails: schedule.recipient_emails,
      report_schedule_id: schedule.id,
    },
    GENERATE_REPORT_JOB_OPTIONS,
  );

  log.info({ jobId: job.id, scheduleId: schedule_id, runId: run.id }, 'fire-scheduled-report dispatched');
}

export const reportWorker = new Worker(
  'reporting-jobs',
  async (job) => {
    if (job.name === 'fire-scheduled-report') {
      await handleScheduledFire(job as Job<FireScheduledReportJob>);
    } else {
      // 'generate-report'
      log.info({ jobId: job.id, runId: (job.data as GenerateReportJob).report_run_id }, 'Processing generate-report job');
      await renderReport(job.data as GenerateReportJob);
      log.info({ jobId: job.id, runId: (job.data as GenerateReportJob).report_run_id }, 'Generate-report job completed');
    }
  },
  { connection: workerRedis },
);

/**
 * After all retry attempts are exhausted for a 'generate-report' job, ensure
 * the report_run row reflects the terminal failure state.
 * (renderReport marks failures on each attempt, but this handler is the
 * authoritative final-failure record.)
 *
 * 'fire-scheduled-report' jobs do not have a report_run row to update.
 */
reportWorker.on('failed', async (job, err) => {
  if (!job || job.name !== 'generate-report') return;
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade >= maxAttempts) {
    const { report_run_id } = job.data as GenerateReportJob;
    log.error(
      { jobId: job.id, report_run_id, err: err.message },
      'Report job exhausted all retries — persisting final failure',
    );
    try {
      await runsRepo.updateStatus(db, report_run_id, 'failed', {
        error_message: err.message,
      });
    } catch (dbErr) {
      log.error({ dbErr }, 'Failed to persist final failure status to DB');
    }
  }
});
