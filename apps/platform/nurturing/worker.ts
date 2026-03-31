import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { Knex } from 'knex';
import pino from 'pino';
import { createStepWorker } from './src/services/step-worker.js';
import { createStepQueue } from './src/queue/step-queue.js';
import { createPublisher } from './src/events/publisher.js';
import { loadServiceUrls } from './src/config/service-urls.js';
import { createDb } from './src/db.js';
import { SequenceVersionsRepository } from './src/repositories/sequence-versions.repo.js';
import { EnrollmentsRepository } from './src/repositories/enrollments.repo.js';
import { StepExecutionsRepository } from './src/repositories/step-executions.repo.js';
import { startOptOutConsumer } from './src/consumers/opt-out.consumer.js';
import { unenroll } from './src/services/unenrollment.js';

const redisUrl = process.env['REDIS_URL'];
if (!redisUrl) {
  throw new Error('Missing required env var: REDIS_URL');
}

if (!process.env['DATABASE_URL']) {
  throw new Error('Missing required env var: DATABASE_URL');
}

const urls = loadServiceUrls();

const db: Knex = createDb();
const queue = createStepQueue(redisUrl);
const publisher = createPublisher();

const versionsRepo = new SequenceVersionsRepository(db);
const enrollmentsRepo = new EnrollmentsRepository(db);
const stepExecutionsRepo = new StepExecutionsRepository(db);

const actionExecutorDeps = {
  urls,
  ebClient: new EventBridgeClient({}),
  busName: process.env['EVENTBRIDGE_BUS_NAME']!,
};

const worker = createStepWorker(redisUrl, {
  db,
  enrollmentsRepo,
  versionsRepo,
  stepExecutionsRepo,
  queue,
  publisher,
  actionExecutorDeps,
});

const optOutQueueUrl = process.env['OPT_OUT_QUEUE_URL'];
if (!optOutQueueUrl) {
  throw new Error('Missing required env var: OPT_OUT_QUEUE_URL');
}

const logger = pino({ name: 'nurturing-worker' });

const stopOptOutConsumer = startOptOutConsumer({
  sqsClient: new SQSClient({}),
  queueUrl: optOutQueueUrl,
  enrollmentsRepo,
  unenroll,
  unenrollDeps: {
    db,
    enrollmentsRepo,
    stepExecutionsRepo,
    stepQueue: queue,
    publisher,
  },
  publisher,
  logger,
});

console.log('Nurturing step worker started');

process.on('SIGTERM', async () => {
  stopOptOutConsumer();
  await worker.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  stopOptOutConsumer();
  await worker.close();
  process.exit(0);
});
