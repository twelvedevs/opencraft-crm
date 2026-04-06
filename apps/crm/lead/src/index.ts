import { buildApp } from './app.js';
import db, { destroy } from './db.js';
import { createEventBus } from '@ortho/event-bus';
import { env } from './env.js';

const eventBus = createEventBus();
const app = await buildApp(db, eventBus);

await app.listen({ port: env.PORT, host: '0.0.0.0' });

process.on('SIGTERM', async () => {
  await app.close();
  await eventBus.stop();
  await destroy();
  process.exit(0);
});
