import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_imports').createTable('column_mappings', (table) => {
    table.string('import_type').primary();
    table.jsonb('mapping').notNullable();
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by').notNullable();
  });

  await knex.raw(`
    ALTER TABLE crm_imports.column_mappings
    ADD CONSTRAINT column_mappings_import_type_check
    CHECK (import_type IN ('active_patients', 'completed_patients', 'scheduled_appointments', 'no_shows'))
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_imports').dropTableIfExists('column_mappings');
}
