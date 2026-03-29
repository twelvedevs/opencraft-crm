import { env } from './env.js';
import { createDb } from './db.js';
import { createEventBus } from '@ortho/event-bus';
import { buildApp } from './app.js';
import { createConnection, createQueues } from './queue.js';
import { createTransactionalSendWorker } from './workers/transactional-send-worker.js';
import { createCampaignRecipientWorker } from './workers/campaign-recipient-worker.js';
import { runCampaignCrashRecovery } from './workers/campaign-crash-recovery.js';

const db = createDb(env.DATABASE_URL);
const eventBus = createEventBus();
const connection = createConnection(env.REDIS_URL);
const queues = createQueues(connection);

await runCampaignCrashRecovery(db, queues.campaignRecipient);

const app = await buildApp(db, eventBus, queues, connection);

await app.listen({ port: env.PORT, host: '0.0.0.0' });

const worker = createTransactionalSendWorker(connection, db, eventBus);
const campaignWorker = createCampaignRecipientWorker(connection, db, eventBus);

// NOTE: ECS stop timeout must be >= 30s to allow campaign-recipient workers to finish
// processing in-flight batch jobs before the task exits.
process.on('SIGTERM', async () => {
  await app.close();            // stop accepting new HTTP requests first
  await worker.close();         // wait for in-flight transactional send job to finish
  await campaignWorker.close(); // wait for in-flight campaign recipient job to finish
  await db.destroy();           // close Knex DB connection pool after workers drain
  await connection.quit();
  process.exit(0);
});
