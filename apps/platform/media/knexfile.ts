import type { Knex } from 'knex';

const config: Knex.Config = {
  client: 'pg',
  connection: process.env.DATABASE_URL,
  searchPath: ['platform_media', 'public'],
  migrations: {
    directory: './migrations',
    schemaName: 'platform_media',
    tableName: 'knex_migrations',
    loadExtensions: ['.ts'],
  },
};

export default config;
