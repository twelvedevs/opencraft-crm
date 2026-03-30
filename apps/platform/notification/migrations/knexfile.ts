import type { Knex } from 'knex';

const config: Knex.Config = {
  client: 'pg',
  connection: process.env.DATABASE_URL,
  searchPath: ['platform_notifications', 'public'],
  migrations: {
    directory: '.',
    schemaName: 'platform_notifications',
    tableName: 'knex_migrations',
    loadExtensions: ['.ts'],
  },
};

export default config;
