import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS crm_leads');
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP SCHEMA IF EXISTS crm_leads CASCADE');
}
