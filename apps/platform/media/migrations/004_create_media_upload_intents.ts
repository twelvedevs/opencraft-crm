import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_media').createTable('media_upload_intents', (table) => {
    table.uuid('id').primary();
    table
      .uuid('file_id')
      .notNullable()
      .references('id')
      .inTable('platform_media.media_files')
      .onDelete('CASCADE');
    table.text('presigned_url').notNullable();
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Index on expires_at for cleanup job
  await knex.raw(`
    CREATE INDEX media_upload_intents_expires_at_idx
    ON platform_media.media_upload_intents (expires_at)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_media').dropTableIfExists('media_upload_intents');
}
