import { env } from './env.js';
import pg from 'pg';
import knexLib from 'knex';
import { buildApp } from './app.js';

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
const knex = knexLib({
  client: 'pg',
  connection: env.DATABASE_URL,
  searchPath: ['platform_media', 'public'],
});

const app = await buildApp(pool, knex);

import { registerCleanupJob } from './jobs/cleanup.js';
registerCleanupJob(knex);

await app.listen({ port: env.PORT, host: '0.0.0.0' });

process.on('SIGTERM', async () => {
  await app.close();
  await knex.destroy();
  await pool.end();
  process.exit(0);
});
