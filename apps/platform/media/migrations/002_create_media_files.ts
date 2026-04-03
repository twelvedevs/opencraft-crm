import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_media').createTable('media_files', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('upload_id').unique().notNullable();
    table.text('tier').notNullable();
    table.text('status').notNullable().defaultTo('pending');
    table.text('mime_type').notNullable();
    table.text('original_key').notNullable();
    table.text('original_filename').notNullable();
    table.bigInteger('file_size_bytes').nullable();
    table.uuid('location_id').nullable();
    table.text('purpose').nullable();
    table.uuid('uploaded_by').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('confirmed_at', { useTz: true }).nullable();
    table.timestamp('deleted_at', { useTz: true }).nullable();
  });

  // CHECK constraints
  await knex.raw(`
    ALTER TABLE platform_media.media_files
    ADD CONSTRAINT media_files_tier_check CHECK (tier IN ('public', 'private'))
  `);

  await knex.raw(`
    ALTER TABLE platform_media.media_files
    ADD CONSTRAINT media_files_status_check CHECK (status IN ('pending', 'ready', 'deleted'))
  `);

  // Index on location_id
  await knex.raw(`
    CREATE INDEX media_files_location_id_idx
    ON platform_media.media_files (location_id)
  `);

  // Partial index on (status, created_at) WHERE status = 'pending'
  await knex.raw(`
    CREATE INDEX media_files_pending_idx
    ON platform_media.media_files (status, created_at)
    WHERE status = 'pending'
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_media').dropTableIfExists('media_files');
}
