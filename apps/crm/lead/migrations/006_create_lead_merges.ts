import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_leads').createTable('lead_merges', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('surviving_lead_id').notNullable().references('id').inTable('crm_leads.leads');
    table.uuid('merged_lead_id').notNullable().references('id').inTable('crm_leads.leads');
    table.uuid('merged_lead_location_id').notNullable();
    table.uuid('merged_by').notNullable();
    table.timestamp('merged_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.varchar('stage_chosen').notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_leads').dropTableIfExists('lead_merges');
}
