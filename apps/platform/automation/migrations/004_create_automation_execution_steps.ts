import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_automation').createTable('automation_execution_steps', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('execution_id').notNullable().references('id').inTable('platform_automation.automation_executions');
    table.text('action_type').notNullable();
    table.jsonb('action_params').nullable();
    table.jsonb('output').nullable();
    table.text('status').notNullable();
    table.integer('attempt').notNullable().defaultTo(0);
    table.text('error').nullable();
    table.timestamp('started_at', { useTz: true }).nullable();
    table.timestamp('completed_at', { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_automation').dropTableIfExists('automation_execution_steps');
}
