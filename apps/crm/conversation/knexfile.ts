import type { Knex } from 'knex';

const config: Knex.Config = {
  client: 'pg',
  connection: process.env['DATABASE_URL'],
  searchPath: ['crm_conversations', 'public'],
  migrations: {
    directory: './migrations',
    schemaName: 'crm_conversations',
    tableName: 'knex_migrations',
    loadExtensions: ['.ts'],
  },
};

export default config;
