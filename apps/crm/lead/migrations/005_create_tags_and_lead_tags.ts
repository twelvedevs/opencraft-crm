import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_leads').createTable('tags', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.varchar('name').notNullable();
    table.uuid('location_id').nullable();
    table.uuid('created_by').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['name', 'location_id']);
  });

  // Partial unique index for global tags (location_id IS NULL)
  await knex.raw(`
    CREATE UNIQUE INDEX tags_name_global_unique_idx ON crm_leads.tags (name)
    WHERE location_id IS NULL
  `);

  await knex.schema.withSchema('crm_leads').createTable('lead_tags', (table) => {
    table.uuid('lead_id').notNullable().references('id').inTable('crm_leads.leads');
    table.uuid('tag_id').notNullable().references('id').inTable('crm_leads.tags');
    table.uuid('applied_by').notNullable();
    table.timestamp('applied_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.primary(['lead_id', 'tag_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_leads').dropTableIfExists('lead_tags');
  await knex.schema.withSchema('crm_leads').dropTableIfExists('tags');
}
