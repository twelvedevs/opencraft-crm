import { env } from './env.js';
import { createDb } from './db.js';
import { createEventBus } from '@ortho/event-bus';
import { buildApp } from './app.js';

const db = createDb(env.DATABASE_URL);
const eventBus = createEventBus();

const app = await buildApp(db, eventBus);

await app.listen({ port: env.PORT, host: '0.0.0.0' });

process.on('SIGTERM', async () => {
  await app.close();
  await db.destroy();
  process.exit(0);
});
