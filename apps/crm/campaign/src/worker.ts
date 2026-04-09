import { createLogger } from '@ortho/logger';
import { createEventBus } from '@ortho/event-bus';
import { bullmqRedis } from './queue/connection.js';
import db, { destroy } from './db.js';
import { startConsumer } from './handlers/sqs-consumer.js';

const log = createLogger('crm-campaign-worker');

import './workers/campaign-orchestrate.worker.js';
import './workers/ab-winner-select.worker.js';

const bus = createEventBus();
startConsumer(db, bus).catch((err) => {
  log.error({ err }, 'Failed to start SQS consumer');
  process.exit(1);
});

log.info('Campaign worker started');

process.on('SIGTERM', async () => {
  log.info('SIGTERM received, shutting down…');
  await bus.stop();
  await bullmqRedis.quit();
  await destroy();
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  log.error({ err }, 'Unhandled rejection in worker');
  process.exit(1);
});
