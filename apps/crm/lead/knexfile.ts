import type { Knex } from 'knex';

const config: Knex.Config = {
  client: 'pg',
  connection: process.env['DATABASE_URL'],
  searchPath: ['crm_leads', 'public'],
  migrations: {
    directory: './migrations',
    schemaName: 'crm_leads',
    tableName: 'knex_migrations',
    loadExtensions: ['.ts'],
  },
};

export default config;
