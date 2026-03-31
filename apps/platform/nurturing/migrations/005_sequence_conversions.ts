import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_nurturing').createTable('sequence_conversions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('enrollment_id')
      .notNullable()
      .references('id')
      .inTable('platform_nurturing.sequence_enrollments');
    table.uuid('sequence_id').notNullable();
    table.text('ab_variant').nullable();
    table.text('entity_type').notNullable();
    table.text('entity_id').notNullable();
    table.text('event_type').notNullable();
    table.timestamp('converted_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['enrollment_id']);
  });

  await knex.raw(
    'CREATE INDEX ON platform_nurturing.sequence_conversions (sequence_id, ab_variant)',
  );
  await knex.raw(
    'CREATE INDEX ON platform_nurturing.sequence_conversions (entity_id, event_type)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_nurturing').dropTableIfExists('sequence_conversions');
}
