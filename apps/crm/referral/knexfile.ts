import type { Knex } from 'knex';

const config: Knex.Config = {
  client: 'pg',
  connection: process.env['DATABASE_URL'],
  searchPath: ['crm_referrals', 'public'],
  migrations: {
    directory: './migrations',
    schemaName: 'crm_referrals',
    tableName: 'knex_migrations',
    loadExtensions: ['.ts'],
  },
};

export default config;
