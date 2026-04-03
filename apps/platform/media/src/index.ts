import { env } from './env.js';
import pg from 'pg';
import { buildApp } from './app.js';

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const app = await buildApp(pool);

// Cleanup job stub — will be implemented in a later story
// import { registerCleanupJob } from './jobs/cleanup.js';
// registerCleanupJob(knex);

await app.listen({ port: env.PORT, host: '0.0.0.0' });

process.on('SIGTERM', async () => {
  await app.close();
  await pool.end();
  process.exit(0);
});
