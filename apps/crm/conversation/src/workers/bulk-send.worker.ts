import { Worker } from 'bullmq';
import type { Knex } from 'knex';
import { createLogger } from '@ortho/logger';
import { executeBulkSend } from '../services/bulk-sender.js';
import { env } from '../env.js';

const logger = createLogger('crm-conversation');

export function createBulkSendWorker(db: Knex): Worker {
  return new Worker(
    'conversation-bulk-send',
    async (job) => {
      const { job_id, location_id, segment, body } = job.data as {
        job_id: string;
        location_id: string;
        segment: unknown;
        body: string;
      };
      const log = logger.child({ jobId: job.id, bulkSendJobId: job_id });

      log.info('Starting bulk send job');
      await executeBulkSend(db, job_id, { locationId: location_id, segment, body });
      log.info('Bulk send job completed');
    },
    {
      connection: { url: env.BULLMQ_REDIS_URL },
      concurrency: env.BULK_SEND_CONCURRENCY,
    },
  );
}
