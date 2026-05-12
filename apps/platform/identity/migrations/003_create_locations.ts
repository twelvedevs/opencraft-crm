import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_identity').createTable('locations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.varchar('name').notNullable();
    table.varchar('phone').notNullable();
    table.varchar('address').notNullable();
    table.varchar('timezone').notNullable();
    table.varchar('status').notNullable().defaultTo('active');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE platform_identity.locations
    ADD CONSTRAINT locations_status_check
    CHECK (status IN ('active','inactive'))
  `);

  await knex.raw('CREATE INDEX locations_status_idx ON platform_identity.locations (status)');
  await knex.raw('CREATE INDEX locations_name_idx ON platform_identity.locations (name)');

  await knex.raw(`
    ALTER TABLE platform_identity.user_locations
    ADD CONSTRAINT user_locations_location_id_fkey
    FOREIGN KEY (location_id) REFERENCES platform_identity.locations(id) ON DELETE RESTRICT
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE platform_identity.user_locations
    DROP CONSTRAINT IF EXISTS user_locations_location_id_fkey
  `);
  await knex.schema.withSchema('platform_identity').dropTableIfExists('locations');
}
