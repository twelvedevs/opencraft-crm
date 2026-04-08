import { createLogger } from '@ortho/logger';
import { bullmqRedis } from './queue/connection.js';
import { destroy } from './db.js';

const log = createLogger('crm-campaign-worker');

// Workers will be imported and started here as they are implemented
// e.g. import './workers/campaign-orchestrate.worker.js';

// SQS consumer will be started here once implemented
// e.g. startConsumer(db, bus);

log.info('Campaign worker started');

process.on('SIGTERM', async () => {
  log.info('SIGTERM received, shutting down…');
  await bullmqRedis.quit();
  await destroy();
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  log.error({ err }, 'Unhandled rejection in worker');
  process.exit(1);
});
