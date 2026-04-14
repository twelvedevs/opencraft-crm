import type { Knex } from 'knex';

const config: Knex.Config = {
  client: 'pg',
  connection: process.env['DATABASE_URL'],
  searchPath: ['platform_nurturing', 'public'],
  migrations: {
    directory: './migrations',
    schemaName: 'platform_nurturing',
    tableName: 'knex_migrations',
    loadExtensions: ['.ts'],
  },
};

export default config;
