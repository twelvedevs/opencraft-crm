import type { Knex } from 'knex';

const config: Knex.Config = {
  client: 'pg',
  connection: process.env.DATABASE_URL,
  searchPath: ['platform_integrations', 'public'],
  migrations: {
    directory: '.',
    schemaName: 'platform_integrations',
    tableName: 'knex_migrations',
    loadExtensions: ['.ts'],
  },
};

export default config;
