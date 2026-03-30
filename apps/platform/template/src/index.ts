import { config } from './config.js';
import { buildApp } from './app.js';
import knex from 'knex';

const db = knex({
  client: 'pg',
  connection: config.DATABASE_URL,
  searchPath: ['platform_templates'],
});

const app = await buildApp(db, config.JWT_SECRET);

if (process.env['NODE_ENV'] !== 'test') {
  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

export { app };
