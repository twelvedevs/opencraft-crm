import { Queue, Worker } from 'bullmq';
import { createEventBus } from '@ortho/event-bus';
import { buildApp } from './app.js';
import db, { destroy } from './db.js';
import { env } from './env.js';
import { handleMessageDelivered } from './events/handlers/message-delivered.handler.js';
import { handleMessageFailed } from './events/handlers/message-failed.handler.js';

const eventBus = createEventBus();

// EventBus subscriptions
eventBus.subscribe('inbound_message.received', async (_event) => {
  // Placeholder — wired in US-008
});
eventBus.subscribe('message.delivered', (event) => handleMessageDelivered(db, event));
eventBus.subscribe('message.failed', (event) => handleMessageFailed(db, event));

await eventBus.start();

// BullMQ queues
const aiAgentQueue = new Queue('conversation:ai-agent-reply', {
  connection: { url: env.BULLMQ_REDIS_URL },
});
const scheduledSendQueue = new Queue('conversation:scheduled-send', {
  connection: { url: env.BULLMQ_REDIS_URL },
});
const bulkSendQueue = new Queue('conversation:bulk-send', {
  connection: { url: env.BULLMQ_REDIS_URL },
});

// BullMQ workers (placeholder processors — wired in later stories)
const aiAgentWorker = new Worker(
  'conversation:ai-agent-reply',
  async (_job) => { /* wired in US-014 */ },
  { connection: { url: env.BULLMQ_REDIS_URL }, concurrency: env.AI_AGENT_CONCURRENCY },
);
const scheduledSendWorker = new Worker(
  'conversation:scheduled-send',
  async (_job) => { /* wired in US-012 */ },
  { connection: { url: env.BULLMQ_REDIS_URL }, concurrency: env.SCHEDULED_SEND_CONCURRENCY },
);
const bulkSendWorker = new Worker(
  'conversation:bulk-send',
  async (_job) => { /* wired in US-015 */ },
  { connection: { url: env.BULLMQ_REDIS_URL }, concurrency: env.BULK_SEND_CONCURRENCY },
);

const app = await buildApp(db, eventBus);
await app.listen({ port: env.PORT, host: '0.0.0.0' });

process.on('SIGTERM', async () => {
  await aiAgentWorker.pause(true);
  await aiAgentWorker.close();
  await scheduledSendWorker.pause(true);
  await scheduledSendWorker.close();
  await bulkSendWorker.pause(true);
  await bulkSendWorker.close();
  await aiAgentQueue.close();
  await scheduledSendQueue.close();
  await bulkSendQueue.close();
  await eventBus.stop();
  await app.close();
  await destroy();
  process.exit(0);
});
