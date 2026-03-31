import { env } from './env.js';
import { createDb } from './db.js';
import { createEventBus } from '@ortho/event-bus';
import { buildApp } from './app.js';
import { Redis } from 'ioredis';

const db = createDb(env.DATABASE_URL);
const eventBus = createEventBus();
const redis = new Redis(env.REDIS_URL);

const app = await buildApp(db, eventBus, redis);

await app.listen({ port: env.PORT, host: '0.0.0.0' });

process.on('SIGTERM', async () => {
  await app.close();
  await db.destroy();
  await redis.quit();
  process.exit(0);
});
