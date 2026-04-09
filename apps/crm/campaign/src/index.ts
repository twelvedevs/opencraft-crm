import { buildApp } from './api.js';
import db, { destroy } from './db.js';
import { env } from './env.js';

const app = await buildApp(db);
await app.listen({ port: env.PORT, host: '0.0.0.0' });

process.on('SIGTERM', async () => {
  await app.close();
  await destroy();
  process.exit(0);
});
