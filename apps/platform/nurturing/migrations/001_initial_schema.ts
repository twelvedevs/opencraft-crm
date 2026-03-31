import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS platform_nurturing');

  await knex.schema.withSchema('platform_nurturing').createTable('sequence_definitions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('name').notNullable();
    table.text('status').notNullable().defaultTo('draft');
    table.integer('active_version').nullable();
    table.integer('current_version').notNullable().defaultTo(1);
    table.uuid('created_by').nullable();
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  await knex.schema.withSchema('platform_nurturing').createTable('sequence_versions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('sequence_id')
      .notNullable()
      .references('id')
      .inTable('platform_nurturing.sequence_definitions');
    table.integer('version').notNullable();
    table.jsonb('active_hours').nullable();
    table.boolean('cancel_on_opt_out').notNullable().defaultTo(true);
    table.jsonb('steps').notNullable();
    table.jsonb('ab_test').nullable();
    table.uuid('created_by').nullable();
    table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    table.unique(['sequence_id', 'version']);
  });

  await knex.schema.withSchema('platform_nurturing').createTable('sequence_enrollments', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('sequence_id')
      .notNullable()
      .references('id')
      .inTable('platform_nurturing.sequence_definitions');
    table.integer('sequence_version').notNullable();
    table.text('entity_type').notNullable();
    table.text('entity_id').notNullable();
    table.jsonb('context').notNullable();
    table.text('ab_variant').nullable();
    table.text('status').notNullable().defaultTo('active');
    table.timestamp('enrolled_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('completed_at', { useTz: true }).nullable();
    table.text('dedup_key').notNullable().unique();
  });

  await knex.schema.withSchema('platform_nurturing').createTable('sequence_step_executions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('enrollment_id')
      .notNullable()
      .references('id')
      .inTable('platform_nurturing.sequence_enrollments');
    table.text('step_id').notNullable();
    table.integer('step_index').notNullable();
    table.timestamp('scheduled_at', { useTz: true }).notNullable();
    table.text('job_id').nullable();
    table.text('status').notNullable().defaultTo('pending');
    table.integer('attempt').notNullable().defaultTo(0);
    table.jsonb('output').nullable();
    table.text('error').nullable();
    table.timestamp('started_at', { useTz: true }).nullable();
    table.timestamp('completed_at', { useTz: true }).nullable();
  });

  // Indexes for sequence_enrollments
  await knex.raw(
    'CREATE INDEX ON platform_nurturing.sequence_enrollments (entity_id, status)',
  );
  await knex.raw(
    'CREATE INDEX ON platform_nurturing.sequence_enrollments (sequence_id, entity_type, entity_id, status)',
  );

  // Indexes for sequence_step_executions
  await knex.raw(
    'CREATE INDEX ON platform_nurturing.sequence_step_executions (enrollment_id, status)',
  );
  await knex.raw(
    'CREATE INDEX ON platform_nurturing.sequence_step_executions (enrollment_id, step_id)',
  );
  await knex.raw(
    "CREATE INDEX ON platform_nurturing.sequence_step_executions (scheduled_at, status) WHERE status = 'pending'",
  );

  /*
   * Seed SQL for the 'Contacted — No Response Follow-up' sequence.
   * Run these INSERTs manually to bootstrap the sequence; not executed by the migration.
   *
   * INSERT INTO platform_nurturing.sequence_definitions (name, status, current_version)
   *   VALUES ('Contacted — No Response Follow-up', 'draft', 1);
   *
   * INSERT INTO platform_nurturing.sequence_versions
   *   (sequence_id, version, cancel_on_opt_out, steps, ab_test)
   * VALUES
   *   ('<id from above>', 1, true,
   *    '[{"id":"step-1","type":"send_message","delay_ms":86400000,"params":{"to":"context.phone","body":"Hi {{first_name}}, just following up!"}},{"id":"step-2","type":"send_message","delay_ms":172800000,"params":{"to":"context.phone","body":"Hi {{first_name}}, one more follow-up."}}]',
   *    '{"enabled": true, "split": {"A": 50, "B": 50}, "variants": {"A": {"step-1": {"body": "Hi {{first_name}}, just following up!"}}, "B": {"step-1": {"body": "Hey {{first_name}}, we want to help you get started!"}}}}');
   */
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_nurturing').dropTableIfExists('sequence_step_executions');
  await knex.schema.withSchema('platform_nurturing').dropTableIfExists('sequence_enrollments');
  await knex.schema.withSchema('platform_nurturing').dropTableIfExists('sequence_versions');
  await knex.schema.withSchema('platform_nurturing').dropTableIfExists('sequence_definitions');
  await knex.raw('DROP SCHEMA IF EXISTS platform_nurturing');
}
