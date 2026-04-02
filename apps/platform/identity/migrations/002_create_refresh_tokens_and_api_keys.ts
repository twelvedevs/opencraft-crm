import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_identity').createTable('refresh_tokens', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable().references('id').inTable('platform_identity.users').onDelete('CASCADE');
    table.varchar('token_hash').unique().notNullable();
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.timestamp('revoked_at', { useTz: true });
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw('CREATE INDEX refresh_tokens_user_id_idx ON platform_identity.refresh_tokens (user_id)');
  await knex.raw('CREATE INDEX refresh_tokens_expires_at_idx ON platform_identity.refresh_tokens (expires_at)');

  await knex.schema.withSchema('platform_identity').createTable('api_keys', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.varchar('name').notNullable();
    table.varchar('key_hash').unique().notNullable();
    table.specificType('permissions', 'varchar[]').notNullable();
    table.uuid('created_by').references('id').inTable('platform_identity.users');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('last_used_at', { useTz: true });
    table.timestamp('revoked_at', { useTz: true });
  });

  await knex.raw('CREATE INDEX api_keys_revoked_at_idx ON platform_identity.api_keys (revoked_at)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('platform_identity').dropTableIfExists('api_keys');
  await knex.schema.withSchema('platform_identity').dropTableIfExists('refresh_tokens');
}
