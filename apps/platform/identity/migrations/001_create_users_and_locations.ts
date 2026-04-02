import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS platform_identity');

  await knex.schema.withSchema('platform_identity').createTable('users', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.varchar('provider_user_id').unique().notNullable();
    table.varchar('email').unique().notNullable();
    table.varchar('name').notNullable();
    table.varchar('role').notNullable();
    table.varchar('status').notNullable().defaultTo('active');
    table.boolean('force_password_reset').notNullable().defaultTo(true);
    table.uuid('created_by').references('id').inTable('platform_identity.users');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE platform_identity.users
    ADD CONSTRAINT users_role_check
    CHECK (role IN ('call_center_agent','call_center_manager','marketing_staff','marketing_manager','super_admin'))
  `);

  await knex.raw(`
    ALTER TABLE platform_identity.users
    ADD CONSTRAINT users_status_check
    CHECK (status IN ('active','inactive'))
  `);

  await knex.raw('CREATE INDEX users_role_idx ON platform_identity.users (role)');
  await knex.raw('CREATE INDEX users_status_idx ON platform_identity.users (status)');
  await knex.raw('CREATE INDEX users_created_at_idx ON platform_identity.users (created_at)');

  await knex.schema.withSchema('platform_identity').createTable('user_locations', (table) => {
    table.uuid('user_id').notNullable().references('id').inTable('platform_identity.users').onDelete('CASCADE');
    table.uuid('location_id').notNullable();
    table.primary(['user_id', 'location_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_identity').dropTableIfExists('user_locations');
  await knex.schema.withSchema('platform_identity').dropTableIfExists('users');
}
