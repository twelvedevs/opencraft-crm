import type { Knex } from 'knex';

const config: Knex.Config = {
  client: 'pg',
  connection: process.env['DATABASE_URL'],
  searchPath: ['platform_analytics', 'public'],
  migrations: {
    directory: './migrations',
    schemaName: 'platform_analytics',
    tableName: 'knex_migrations',
    loadExtensions: ['.ts'],
  },
};

export default config;
