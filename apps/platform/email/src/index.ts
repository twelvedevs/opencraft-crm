import { env } from './env.js';
import { createDb } from './db.js';
import { createEventBus } from '@ortho/event-bus';
import { buildApp } from './app.js';
import { createConnection, createQueues } from './queue.js';

const db = createDb(env.DATABASE_URL);
const eventBus = createEventBus();
const connection = createConnection(env.REDIS_URL);
const queues = createQueues(connection);

const app = await buildApp(db, eventBus, queues);

await app.listen({ port: env.PORT, host: '0.0.0.0' });

process.on('SIGTERM', async () => {
  await app.close();
  await connection.quit();
  await db.destroy();
  process.exit(0);
});
