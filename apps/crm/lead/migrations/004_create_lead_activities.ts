import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_leads').createTable('lead_activities', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('lead_id').notNullable().references('id').inTable('crm_leads.leads');
    table.varchar('event_type').notNullable();
    table.varchar('actor_type').notNullable();
    table.uuid('actor_id').nullable();
    table.jsonb('payload').notNullable().defaultTo('{}');
    table.timestamp('occurred_at', { useTz: true }).notNullable();
    table.varchar('source_event_id').notNullable();
  });

  // Check constraint
  await knex.raw(`
    ALTER TABLE crm_leads.lead_activities
    ADD CONSTRAINT lead_activities_actor_type_check
    CHECK (actor_type IN ('system','staff','automation'))
  `);

  // Indexes
  await knex.raw('CREATE INDEX lead_activities_lead_occurred_idx ON crm_leads.lead_activities (lead_id, occurred_at DESC)');
  await knex.raw('CREATE UNIQUE INDEX lead_activities_source_event_id_idx ON crm_leads.lead_activities (source_event_id)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_leads').dropTableIfExists('lead_activities');
}
