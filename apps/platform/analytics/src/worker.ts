import { env } from './env.js';
import { Pool } from 'pg';
import { createSqsConsumer } from './services/sqs-consumer.js';

const pool = new Pool({ connectionString: env.DATABASE_URL });
const consumer = createSqsConsumer(pool);

await consumer.start();

process.on('SIGTERM', async () => {
  await consumer.stop();
  await pool.end();
  process.exit(0);
});
