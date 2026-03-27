import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_automation').createTable('automation_rule_versions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('rule_id').notNullable().references('id').inTable('platform_automation.automation_rules');
    table.integer('version').notNullable();
    table.text('trigger_event_type').notNullable();
    table.jsonb('condition').nullable();
    table.jsonb('active_hours').nullable();
    table.jsonb('action_tree').notNullable();
    table.uuid('created_by').nullable();
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.unique(['rule_id', 'version']);
    table.index('trigger_event_type');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_automation').dropTableIfExists('automation_rule_versions');
}
