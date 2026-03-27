import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS platform_automation');
  await knex.schema.withSchema('platform_automation').createTable('automation_rules', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('name').notNullable();
    table.text('status').notNullable().defaultTo('draft');
    table.integer('active_version').nullable();
    table.integer('current_version').notNullable().defaultTo(1);
    table.uuid('created_by').nullable();
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_automation').dropTableIfExists('automation_rules');
}
