import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { createDb } from './db.js';
import rulesRoutes from './routes/rules.js';
import { RulesRepository } from './repositories/rules.repository.js';
import { RuleCache } from './services/rule-cache.js';
import { RuleMatcher } from './services/rule-matcher.js';
import { EventConsumer, type ExecutionManagerPort } from './services/event-consumer.js';
import { SqsConsumer } from './events/sqs-consumer.js';

const fastify = Fastify({ logger: true });

await fastify.register(sensible);

fastify.get('/healthz', async () => {
  return { ok: true };
});

const db = createDb();

await fastify.register(rulesRoutes, { db });

const port = parseInt(process.env['PORT'] ?? '3000', 10);

try {
  await fastify.listen({ port, host: '0.0.0.0' });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

const repo = new RulesRepository(db);
const cache = new RuleCache(repo);
const matcher = new RuleMatcher(cache);
const executionManagerStub: ExecutionManagerPort = { async handle() {} };
const consumer = new EventConsumer(matcher, executionManagerStub, fastify.log as Pick<Console, 'info' | 'error'>);

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
  await fastify.close();
});
