import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_referrals').createTable('referral_links', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('referrer_id').notNullable().references('id').inTable('crm_referrals.referrers');
    table.text('code').notNullable().unique();
    table.text('redirect_url').notNullable();
    table.integer('click_count').notNullable().defaultTo(0);
    table.text('status').notNullable().defaultTo('active');
    table.uuid('created_by').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // CHECK constraint
  await knex.raw(`
    ALTER TABLE crm_referrals.referral_links
    ADD CONSTRAINT referral_links_status_check CHECK (status IN ('active', 'inactive'))
  `);

  // Indexes
  await knex.raw(`
    CREATE INDEX referral_links_referrer_status_idx
    ON crm_referrals.referral_links (referrer_id, status)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_referrals').dropTableIfExists('referral_links');
}
