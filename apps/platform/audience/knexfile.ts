import type { Knex } from 'knex';

const config: Knex.Config = {
  client: 'pg',
  connection: process.env['DATABASE_URL'],
  searchPath: ['platform_audience', 'public'],
  migrations: {
    directory: './migrations',
    schemaName: 'platform_audience',
    tableName: 'knex_migrations',
  },
};

export default config;
