import { buildApp } from './app.js';
import db, { destroy } from './db.js';
import { createEventBus } from '@ortho/event-bus';
import { env } from './env.js';
import { createTimeoutPollJob } from './jobs/timeout-poll.job.js';

const eventBus = createEventBus();
const app = await buildApp(db, eventBus);

await app.listen({ port: env.PORT, host: '0.0.0.0' });
await eventBus.start();

const pollJob = createTimeoutPollJob(db, eventBus);
pollJob.start();

process.on('SIGTERM', async () => {
  pollJob.stop();
  await app.close();
  await eventBus.stop();
  await destroy();
  process.exit(0);
});
