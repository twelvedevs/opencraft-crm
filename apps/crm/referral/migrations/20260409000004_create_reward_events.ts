import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_referrals').createTable('reward_events', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('referral_id').notNullable().references('id').inTable('crm_referrals.referrals');
    table.uuid('referrer_id').notNullable().references('id').inTable('crm_referrals.referrers');
    table.text('status').notNullable().defaultTo('pending');
    table.text('reward_type').nullable();
    table.decimal('reward_amount').nullable();
    table.text('reward_notes').nullable();
    table.timestamp('issued_at', { useTz: true }).nullable();
    table.uuid('issued_by').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // CHECK constraint
  await knex.raw(`
    ALTER TABLE crm_referrals.reward_events
    ADD CONSTRAINT reward_events_status_check CHECK (status IN ('pending', 'issued'))
  `);

  // Unique constraint: one reward per conversion
  await knex.raw(`
    ALTER TABLE crm_referrals.reward_events
    ADD CONSTRAINT reward_events_referral_id_unique UNIQUE (referral_id)
  `);

  // Indexes
  await knex.raw(`
    CREATE INDEX reward_events_status_created_idx
    ON crm_referrals.reward_events (status, created_at)
  `);

  await knex.raw(`
    CREATE INDEX reward_events_referrer_id_idx
    ON crm_referrals.reward_events (referrer_id)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_referrals').dropTableIfExists('reward_events');
}
