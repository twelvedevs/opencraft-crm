import { Worker } from 'bullmq';
import type { JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { createLogger } from '@ortho/logger';
import { env } from '../env.js';
import { renderReport, type GenerateReportJob } from '../services/report-renderer.js';
import db from '../db.js';
import * as runsRepo from '../repositories/runs.js';

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

const log = createLogger('crm-reporting:worker');

const workerRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const reportWorker = new Worker<GenerateReportJob>(
  'reporting-jobs',
  async (job) => {
    log.info({ jobId: job.id, runId: job.data.report_run_id }, 'Processing generate-report job');
    await renderReport(job.data);
    log.info({ jobId: job.id, runId: job.data.report_run_id }, 'Generate-report job completed');
  },
  { connection: workerRedis },
);

/**
 * After all retry attempts are exhausted, ensure the report_run row reflects
 * the terminal failure state.  (renderReport marks failures on each attempt,
 * but this handler is the authoritative final-failure record.)
 */
reportWorker.on('failed', async (job, err) => {
  if (!job) return;
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade >= maxAttempts) {
    const { report_run_id } = job.data;
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
