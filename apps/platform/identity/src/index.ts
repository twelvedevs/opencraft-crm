import { env } from './env.js';
import pg from 'pg';
import { createAuthProvider } from './providers/index.js';
import { buildApp } from './app.js';
import { registerCleanupJob } from './jobs/cleanup.job.js';

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const provider = createAuthProvider(env.AUTH_PROVIDER);
const app = await buildApp(pool, provider);
const { worker, queue } = registerCleanupJob(env.REDIS_URL, pool);

await app.listen({ port: env.PORT, host: '0.0.0.0' });

process.on('SIGTERM', async () => {
  await worker.close();
  await queue.close();
  await app.close();
  await pool.end();
  process.exit(0);
});
