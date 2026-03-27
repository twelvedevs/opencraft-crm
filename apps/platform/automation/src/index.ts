import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { createDb } from './db.js';
import rulesRoutes from './routes/rules.js';
import { RulesRepository } from './repositories/rules.repository.js';
import { RuleCache } from './services/rule-cache.js';
import { RuleMatcher } from './services/rule-matcher.js';
import { EventConsumer } from './services/event-consumer.js';
import { SqsConsumer } from './events/sqs-consumer.js';
import { ExecutionRepository } from './repositories/execution.repository.js';
import { ExecutionManager } from './services/execution-manager.js';
import { createQueue, QUEUE_NAME } from './queue/index.js';
import { createActionWorker } from './queue/worker-factory.js';
import { createBranchProcessor } from './services/action-workers/branch.worker.js';
import { createEnrollSequenceProcessor } from './services/action-workers/enroll-sequence.worker.js';
import { createEmitEventProcessor } from './services/action-workers/emit-event.worker.js';
import { createSendMessageProcessor } from './services/action-workers/send-message.worker.js';
import { createSendEmailProcessor } from './services/action-workers/send-email.worker.js';
import { JobCanceller } from './services/job-canceller.js';

const fastify = Fastify({ logger: true });

await fastify.register(sensible);

fastify.get('/healthz', async () => {
  return { ok: true };
});

const db = createDb();

const connection = { url: process.env['REDIS_URL'] ?? 'redis://localhost:6379' };
const queue = createQueue(connection);
const jobCanceller = new JobCanceller(queue);

await fastify.register(rulesRoutes, { db, jobCanceller });

const port = parseInt(process.env['PORT'] ?? '3000', 10);

try {
  await fastify.listen({ port, host: '0.0.0.0' });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

const execRepo = new ExecutionRepository(db);
const executionManager = new ExecutionManager(execRepo, queue);

const repo = new RulesRepository(db);
const cache = new RuleCache(repo);
const matcher = new RuleMatcher(cache);
const consumer = new EventConsumer(matcher, executionManager, fastify.log as Pick<Console, 'info' | 'error'>);

const workers = [
  createActionWorker(QUEUE_NAME, connection, createBranchProcessor(execRepo, queue), fastify.log as Pick<Console, 'error'>),
  createActionWorker(QUEUE_NAME, connection, createEnrollSequenceProcessor(execRepo, queue), fastify.log as Pick<Console, 'error'>),
  createActionWorker(QUEUE_NAME, connection, createEmitEventProcessor(execRepo, queue), fastify.log as Pick<Console, 'error'>),
  createActionWorker(QUEUE_NAME, connection, createSendMessageProcessor(execRepo, queue), fastify.log as Pick<Console, 'error'>),
  createActionWorker(QUEUE_NAME, connection, createSendEmailProcessor(execRepo, queue), fastify.log as Pick<Console, 'error'>),
];

const queueUrl = process.env['SQS_QUEUE_URL'] ?? '';
let sqsConsumer: SqsConsumer | undefined;

if (!queueUrl) {
  fastify.log.warn('SQS_QUEUE_URL is not set — SQS consumer will not start');
} else {
  sqsConsumer = new SqsConsumer({
    queueUrl,
    onMessage: (body) => consumer.process(body),
    logger: fastify.log as Pick<Console, 'info' | 'error'>,
  });
  sqsConsumer.start();
}

process.on('SIGTERM', async () => {
  if (sqsConsumer) {
    await sqsConsumer.stop();
  }
  await Promise.all(workers.map((w) => w.close()));
  await fastify.close();
});
