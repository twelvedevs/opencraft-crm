import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('audience_segments', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('name').notNullable();
    table.text('status').notNullable().defaultTo('draft');
    table.integer('active_version').nullable();
    table.integer('current_version').notNullable().defaultTo(1);
    table.uuid('created_by').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['status']);
  });

  await knex.schema.createTable('audience_segment_versions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('segment_id').notNullable().references('id').inTable('audience_segments');
    table.integer('version').notNullable();
    table.jsonb('filter').notNullable();
    table.uuid('created_by').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['segment_id', 'version']);
  });

  await knex.schema.createTable('audience_snapshots', (table) => {
    table.uuid('id').primary(); // no default — caller-supplied
    table.uuid('segment_id').nullable().references('id').inTable('audience_segments');
    table.integer('segment_version').nullable();
    table.jsonb('filter_snapshot').notNullable();
    table.text('status').notNullable().defaultTo('accumulating');
    table.integer('matched_count').notNullable().defaultTo(0);
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.uuid('created_by').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['segment_id']);
    table.index(['expires_at']);
  });

  await knex.schema.createTable('audience_snapshot_members', (table) => {
    table.uuid('snapshot_id').notNullable().references('id').inTable('audience_snapshots').onDelete('CASCADE');
    table.text('entity_id').notNullable();
    table.primary(['snapshot_id', 'entity_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('audience_snapshot_members');
  await knex.schema.dropTableIfExists('audience_snapshots');
  await knex.schema.dropTableIfExists('audience_segment_versions');
  await knex.schema.dropTableIfExists('audience_segments');
}
