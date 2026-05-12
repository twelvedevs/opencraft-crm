import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_templates').createTable('template_versions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('template_id')
      .notNullable()
      .references('id')
      .inTable('platform_templates.templates')
      .onDelete('CASCADE');
    table.integer('version').notNullable();
    table.text('body_text').nullable();
    table.text('subject').nullable();
    table.text('body_html').nullable();
    table.jsonb('body_unlayer').nullable();
    table.uuid('created_by').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['template_id', 'version']);
  });

  await knex.raw(`
    CREATE INDEX template_versions_template_id_idx ON platform_templates.template_versions (template_id)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_templates').dropTableIfExists('template_versions');
}
