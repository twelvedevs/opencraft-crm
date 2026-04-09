import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_referrals').createTable('referrers', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('referrer_type').notNullable();
    table.uuid('lead_id').nullable();
    table.uuid('location_id').notNullable();
    table.text('name').notNullable();
    table.text('phone').nullable();
    table.text('email').nullable();
    table.text('practice_name').nullable();
    table.text('address').nullable();
    table.text('status').notNullable().defaultTo('active');
    table.uuid('created_by').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // CHECK constraints
  await knex.raw(`
    ALTER TABLE crm_referrals.referrers
    ADD CONSTRAINT referrers_type_check CHECK (referrer_type IN ('patient', 'doctor'))
  `);

  await knex.raw(`
    ALTER TABLE crm_referrals.referrers
    ADD CONSTRAINT referrers_status_check CHECK (status IN ('active', 'inactive'))
  `);

  // Partial unique index: one referrer record per patient lead
  await knex.raw(`
    CREATE UNIQUE INDEX referrers_lead_id_patient_unique
    ON crm_referrals.referrers (lead_id)
    WHERE referrer_type = 'patient'
  `);

  // Indexes
  await knex.raw(`
    CREATE INDEX referrers_location_type_status_idx
    ON crm_referrals.referrers (location_id, referrer_type, status)
  `);

  await knex.raw(`
    CREATE INDEX referrers_lead_id_idx
    ON crm_referrals.referrers (lead_id)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_referrals').dropTableIfExists('referrers');
}
