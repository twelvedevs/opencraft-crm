import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_imports').createTable('import_rows', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('import_id').notNullable().references('id').inTable('crm_imports.imports').onDelete('CASCADE');
    table.integer('row_number').notNullable();
    table.jsonb('raw_data').notNullable();
    table.uuid('matched_lead_id').nullable();
    table.smallint('match_tier').nullable();
    table.specificType('candidate_ids', 'uuid[]').nullable();
    table.text('status').notNullable().defaultTo('pending');
    table.jsonb('before_snapshot').nullable();
    table.string('error_message').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['import_id', 'row_number']);
  });

  await knex.raw(`
    ALTER TABLE crm_imports.import_rows
    ADD CONSTRAINT import_rows_status_check
    CHECK (status IN ('pending', 'matched', 'unmatched', 'ambiguous', 'executing', 'executed', 'failed', 'undone'))
  `);

  await knex.raw(
    'CREATE INDEX import_rows_import_id_idx ON crm_imports.import_rows (import_id)'
  );
  await knex.raw(
    'CREATE INDEX import_rows_import_id_status_idx ON crm_imports.import_rows (import_id, status)'
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_imports').dropTableIfExists('import_rows');
}
