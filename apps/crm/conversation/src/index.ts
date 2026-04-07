import { Queue } from 'bullmq';
import { createEventBus } from '@ortho/event-bus';
import { buildApp } from './app.js';
import db, { destroy } from './db.js';
import { env } from './env.js';
import { handleInboundMessage } from './events/handlers/inbound-message.handler.js';
import { handleMessageDelivered } from './events/handlers/message-delivered.handler.js';
import { handleMessageFailed } from './events/handlers/message-failed.handler.js';
import { createAiAgentReplyWorker } from './workers/ai-agent-reply.worker.js';
import { createScheduledSendWorker } from './workers/scheduled-send.worker.js';
import { createBulkSendWorker } from './workers/bulk-send.worker.js';

const eventBus = createEventBus();

// BullMQ queues
const aiAgentQueue = new Queue('conversation:ai-agent-reply', {
  connection: { url: env.BULLMQ_REDIS_URL },
});

// EventBus subscriptions
eventBus.subscribe('inbound_message.received', (event) =>
  handleInboundMessage(db, eventBus, { aiAgentQueue }, event),
);
eventBus.subscribe('message.delivered', (event) => handleMessageDelivered(db, event));
eventBus.subscribe('message.failed', (event) => handleMessageFailed(db, event));

await eventBus.start();

const scheduledSendQueue = new Queue('conversation:scheduled-send', {
  connection: { url: env.BULLMQ_REDIS_URL },
});
const bulkSendQueue = new Queue('conversation:bulk-send', {
  connection: { url: env.BULLMQ_REDIS_URL },
});

// BullMQ workers
const aiAgentWorker = createAiAgentReplyWorker(db);
const scheduledSendWorker = createScheduledSendWorker(db);
const bulkSendWorker = createBulkSendWorker(db);

const app = await buildApp(db, eventBus, { scheduledSendQueue });
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
