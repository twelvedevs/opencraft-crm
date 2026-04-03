import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_media').createTable('media_variants', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('file_id')
      .notNullable()
      .references('id')
      .inTable('platform_media.media_files')
      .onDelete('CASCADE');
    table.text('variant').notNullable();
    table.text('s3_key').notNullable();
    table.integer('width_px').notNullable();
    table.bigInteger('size_bytes').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['file_id', 'variant']);
  });

  // CHECK constraint on variant
  await knex.raw(`
    ALTER TABLE platform_media.media_variants
    ADD CONSTRAINT media_variants_variant_check CHECK (variant IN ('medium', 'thumb'))
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_media').dropTableIfExists('media_variants');
}
