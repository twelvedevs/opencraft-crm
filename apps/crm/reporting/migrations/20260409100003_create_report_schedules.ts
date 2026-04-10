import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_reporting').createTable('report_schedules', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('report_config_id')
      .notNullable()
      .references('id')
      .inTable('crm_reporting.report_configs')
      .onDelete('CASCADE');
    table.text('frequency').notNullable();
    table.integer('day_of_week').nullable();
    table.integer('day_of_month').nullable();
    table.integer('hour_utc').notNullable();
    table.specificType('recipient_emails', 'text[]').notNullable();
    table.text('format').notNullable().defaultTo('pdf');
    table.boolean('active').notNullable().defaultTo(true);
    table.text('created_by').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE crm_reporting.report_schedules
    ADD CONSTRAINT report_schedules_frequency_check
    CHECK (frequency IN ('daily', 'weekly', 'monthly'))
  `);

  await knex.raw(`
    ALTER TABLE crm_reporting.report_schedules
    ADD CONSTRAINT report_schedules_format_check
    CHECK (format IN ('pdf', 'csv'))
  `);

  await knex.raw(`
    ALTER TABLE crm_reporting.report_schedules
    ADD CONSTRAINT report_schedules_hour_utc_check
    CHECK (hour_utc >= 0 AND hour_utc <= 23)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_reporting').dropTableIfExists('report_schedules');
}
