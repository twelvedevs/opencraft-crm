import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_reporting').createTable('report_runs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('report_config_id')
      .notNullable()
      .references('id')
      .inTable('crm_reporting.report_configs');
    table
      .uuid('report_schedule_id')
      .nullable()
      .references('id')
      .inTable('crm_reporting.report_schedules');
    table.text('triggered_by').notNullable();
    table.text('format').notNullable();
    table.text('status').notNullable();
    table.text('media_file_id').nullable();
    table.text('error_message').nullable();
    table.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('completed_at', { useTz: true }).nullable();
    table.specificType('recipient_emails', 'text[]').nullable();
  });

  await knex.raw(`
    ALTER TABLE crm_reporting.report_runs
    ADD CONSTRAINT report_runs_format_check
    CHECK (format IN ('pdf', 'csv'))
  `);

  await knex.raw(`
    ALTER TABLE crm_reporting.report_runs
    ADD CONSTRAINT report_runs_status_check
    CHECK (status IN ('pending', 'running', 'done', 'failed'))
  `);

  await knex.raw(`
    CREATE INDEX report_runs_config_started_at_idx
    ON crm_reporting.report_runs (report_config_id, started_at DESC)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_reporting').dropTableIfExists('report_runs');
}
