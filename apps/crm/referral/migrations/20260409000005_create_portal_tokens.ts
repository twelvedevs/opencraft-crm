import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_referrals').createTable('portal_tokens', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('referrer_id').notNullable().references('id').inTable('crm_referrals.referrers');
    table.uuid('token').notNullable().unique().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('created_by').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Unique constraint: one active token per referrer
  await knex.raw(`
    ALTER TABLE crm_referrals.portal_tokens
    ADD CONSTRAINT portal_tokens_referrer_id_unique UNIQUE (referrer_id)
  `);

  // Index for public lookup
  await knex.raw(`
    CREATE INDEX portal_tokens_token_idx
    ON crm_referrals.portal_tokens (token)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_referrals').dropTableIfExists('portal_tokens');
}
