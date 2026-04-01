import { env } from './env.js';
import { createDb } from './db.js';
import { createEventBus } from '@ortho/event-bus';
import { buildApp } from './app.js';
import { Redis } from 'ioredis';
import { createTwilioClient } from './services/twilio-client.js';

const db = createDb(env.DATABASE_URL);
const eventBus = createEventBus();
const redis = new Redis(env.REDIS_URL);
const twilioClient = createTwilioClient(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

const app = await buildApp(db, eventBus, redis, twilioClient, env.TWILIO_STATUS_CALLBACK_URL);

await app.listen({ port: env.PORT, host: '0.0.0.0' });

process.on('SIGTERM', async () => {
  await app.close();
  await db.destroy();
  await redis.quit();
  process.exit(0);
});
