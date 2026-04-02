import { env } from './env.js';
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { createSqsConsumer } from './services/sqs-consumer.js';
import { registerPartitionMaintenanceJob } from './jobs/partition-maintenance.js';
import { createRecomputeRollupsWorker } from './jobs/recompute-rollups.js';

const pool = new Pool({ connectionString: env.DATABASE_URL });
const app = await buildApp(pool);
const consumer = createSqsConsumer(pool);

// BullMQ queues — job scheduling is tied to the HTTP server process (not worker.ts)
const queueConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});
const maintenanceQueue = new Queue('analytics:maintenance', { connection: queueConnection });
const recomputeQueue = new Queue('analytics:recompute', { connection: queueConnection });

registerPartitionMaintenanceJob(maintenanceQueue, pool);
createRecomputeRollupsWorker(recomputeQueue, pool);

await app.listen({ port: env.PORT, host: '0.0.0.0' });
await consumer.start();

process.on('SIGTERM', async () => {
  await consumer.stop();
  await app.close();
  await pool.end();
  process.exit(0);
});
