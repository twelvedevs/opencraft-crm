import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_reporting').createTable('location_revenue_config', (table) => {
    table.text('location_id').primary();
    table.decimal('avg_contract_value', 10, 2).notNullable();
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.text('updated_by').notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_reporting').dropTableIfExists('location_revenue_config');
}
