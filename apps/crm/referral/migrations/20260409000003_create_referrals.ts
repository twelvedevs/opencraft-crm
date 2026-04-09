import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_referrals').createTable('referrals', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('referral_link_id').notNullable().references('id').inTable('crm_referrals.referral_links');
    table.uuid('referrer_id').notNullable().references('id').inTable('crm_referrals.referrers');
    table.uuid('lead_id').notNullable().unique();
    table.uuid('location_id').notNullable();
    table.text('status').notNullable().defaultTo('created');
    table.timestamp('exam_scheduled_at', { useTz: true }).nullable();
    table.timestamp('converted_at', { useTz: true }).nullable();
    table.boolean('notify_on_exam').notNullable().defaultTo(true);
    table.boolean('notify_on_conversion').notNullable().defaultTo(true);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // CHECK constraint
  await knex.raw(`
    ALTER TABLE crm_referrals.referrals
    ADD CONSTRAINT referrals_status_check CHECK (status IN ('created', 'exam_scheduled', 'converted'))
  `);

  // Indexes
  await knex.raw(`
    CREATE INDEX referrals_referrer_status_idx
    ON crm_referrals.referrals (referrer_id, status)
  `);

  await knex.raw(`
    CREATE INDEX referrals_location_status_idx
    ON crm_referrals.referrals (location_id, status)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_referrals').dropTableIfExists('referrals');
}
