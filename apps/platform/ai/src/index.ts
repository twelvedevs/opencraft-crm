import './instrumentation.js';

import { env } from './env.js';
import { createPool } from './repositories/completions.js';
import { buildApp } from './app.js';

const pool = createPool(env.DATABASE_URL);
const app = await buildApp(pool);

await app.listen({ port: env.PORT, host: '0.0.0.0' });

process.on('SIGTERM', async () => {
  await app.close();
  await pool.end();
  process.exit(0);
});
