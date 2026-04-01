import { env } from './env.js';
import { createDb } from './db.js';
import { Redis } from 'ioredis';
import { buildApp } from './app.js';

const db = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const app = await buildApp(db, redis);

await app.listen({ port: env.PORT, host: '0.0.0.0' });

process.on('SIGTERM', async () => {
  await app.close();
  await db.destroy();
  await redis.disconnect();
  process.exit(0);
});
