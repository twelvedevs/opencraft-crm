import type { Knex } from 'knex';

const config: Knex.Config = {
  client: 'pg',
  connection: process.env['DATABASE_URL'],
  searchPath: ['platform_ai', 'public'],
  migrations: {
    directory: './migrations',
    schemaName: 'platform_ai',
    tableName: 'knex_migrations',
    loadExtensions: ['.ts'],
  },
};

export default config;
