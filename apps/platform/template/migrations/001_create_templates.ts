import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS platform_templates');

  await knex.schema.withSchema('platform_templates').createTable('templates', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('name').notNullable().unique();
    table.text('channel').notNullable();
    table.text('status').notNullable().defaultTo('draft');
    table.integer('active_version').nullable();
    table.integer('current_version').notNullable().defaultTo(1);
    table.uuid('created_by').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE platform_templates.templates
    ADD CONSTRAINT templates_channel_check CHECK (channel IN ('sms', 'email'))
  `);

  await knex.raw(`
    ALTER TABLE platform_templates.templates
    ADD CONSTRAINT templates_status_check CHECK (status IN ('draft', 'active', 'disabled'))
  `);

  await knex.raw(`
    CREATE INDEX templates_channel_idx ON platform_templates.templates (channel)
  `);

  await knex.raw(`
    CREATE INDEX templates_status_idx ON platform_templates.templates (status)
  `);

  await knex.raw(`
    CREATE INDEX templates_updated_at_idx ON platform_templates.templates (updated_at DESC)
  `);

  await knex.raw(`
    CREATE INDEX templates_created_at_idx ON platform_templates.templates (created_at DESC)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_templates').dropTableIfExists('templates');
}
