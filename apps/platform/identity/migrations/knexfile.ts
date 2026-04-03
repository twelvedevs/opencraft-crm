import type { Knex } from 'knex';

const config: Knex.Config = {
  client: 'pg',
  connection: process.env['DATABASE_URL'],
  searchPath: ['platform_identity', 'public'],
  migrations: {
    directory: '.',
    schemaName: 'platform_identity',
    tableName: 'knex_migrations',
    loadExtensions: ['.ts'],
  },
};

export default config;
