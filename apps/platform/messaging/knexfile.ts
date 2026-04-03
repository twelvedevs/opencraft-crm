import type { Knex } from 'knex';

const config: Knex.Config = {
  client: 'pg',
  connection: process.env['DATABASE_URL'],
  searchPath: ['platform_messaging', 'public'],
  migrations: {
    directory: './migrations',
    schemaName: 'platform_messaging',
    tableName: 'knex_migrations',
  },
  seeds: {
    directory: './seeds',
  },
};

export default config;
