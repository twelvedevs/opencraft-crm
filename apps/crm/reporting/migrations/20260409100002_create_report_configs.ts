import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_reporting').createTable('report_configs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('name').notNullable();
    table.text('report_type').notNullable();
    table.jsonb('parameters').notNullable().defaultTo('{}');
    table.text('created_by').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE crm_reporting.report_configs
    ADD CONSTRAINT report_configs_type_check
    CHECK (report_type IN ('weekly_summary', 'monthly_executive', 'channel_deep_dive', 'coordinator_productivity', 'lead_source'))
  `);

  await knex.raw(`
    CREATE INDEX report_configs_created_by_idx
    ON crm_reporting.report_configs (created_by)
  `);

  await knex.raw(`
    CREATE INDEX report_configs_created_at_idx
    ON crm_reporting.report_configs (created_at DESC)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_reporting').dropTableIfExists('report_configs');
}
