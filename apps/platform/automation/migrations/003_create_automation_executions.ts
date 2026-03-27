import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_automation').createTable('automation_executions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('rule_id').notNullable().references('id').inTable('platform_automation.automation_rules');
    table.integer('rule_version').notNullable();
    table.jsonb('action_tree_snapshot').notNullable();
    table.text('event_id').notNullable();
    table.text('event_type').notNullable();
    table.text('entity_type').nullable();
    table.text('entity_id').nullable();
    table.text('status').notNullable();
    table.timestamp('started_at', { useTz: true }).nullable();
    table.timestamp('completed_at', { useTz: true }).nullable();
    table.unique(['event_id', 'rule_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_automation').dropTableIfExists('automation_executions');
}
