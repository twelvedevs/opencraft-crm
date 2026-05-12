import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_leads').createTable('appointments', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('lead_id').notNullable().references('id').inTable('crm_leads.leads');
    table.uuid('location_id').notNullable();
    table.varchar('appointment_type').notNullable();
    table.timestamp('scheduled_at', { useTz: true }).notNullable();
    table.varchar('status').notNullable().defaultTo('scheduled');
    table.text('notes').nullable();
    table.uuid('created_by').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Check constraints
  await knex.raw(`
    ALTER TABLE crm_leads.appointments
    ADD CONSTRAINT appointments_type_check
    CHECK (appointment_type IN ('exam','follow_up','other'))
  `);

  await knex.raw(`
    ALTER TABLE crm_leads.appointments
    ADD CONSTRAINT appointments_status_check
    CHECK (status IN ('scheduled','completed','cancelled','no_show'))
  `);

  // Indexes
  await knex.raw('CREATE INDEX appointments_lead_id_idx ON crm_leads.appointments (lead_id)');
  await knex.raw('CREATE INDEX appointments_location_status_scheduled_idx ON crm_leads.appointments (location_id, status, scheduled_at)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_leads').dropTableIfExists('appointments');
}
