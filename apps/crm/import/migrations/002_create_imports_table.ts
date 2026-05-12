import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_imports').createTable('imports', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('location_id').notNullable();
    table.text('import_type').notNullable();
    table.text('status').notNullable().defaultTo('uploading');
    table.uuid('uploaded_by').notNullable();
    table.text('file_name').notNullable();
    table.text('file_key').notNullable();
    table.jsonb('column_mapping').nullable();
    table.specificType('detected_headers', 'text[]').nullable();
    table.integer('row_count').nullable();
    table.integer('matched_count').nullable();
    table.integer('unmatched_count').nullable();
    table.integer('ambiguous_count').nullable();
    table.integer('executed_count').nullable();
    table.integer('failed_count').nullable();
    table.text('error_message').nullable();
    table.timestamp('completed_at', { useTz: true }).nullable();
    table.timestamp('undo_deadline', { useTz: true }).nullable();
    table.timestamp('undone_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE crm_imports.imports
    ADD CONSTRAINT imports_import_type_check
    CHECK (import_type IN ('active_patients', 'completed_patients', 'scheduled_appointments', 'no_shows'))
  `);

  await knex.raw(`
    ALTER TABLE crm_imports.imports
    ADD CONSTRAINT imports_status_check
    CHECK (status IN ('uploading', 'parsing', 'preview_ready', 'executing', 'completed', 'failed', 'cancelled', 'undoing', 'undone'))
  `);

  await knex.raw(
    'CREATE INDEX imports_location_id_created_at_idx ON crm_imports.imports (location_id, created_at DESC)'
  );
  await knex.raw(
    'CREATE INDEX imports_uploaded_by_idx ON crm_imports.imports (uploaded_by)'
  );
  await knex.raw(
    'CREATE INDEX imports_status_idx ON crm_imports.imports (status)'
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_imports').dropTableIfExists('imports');
}
