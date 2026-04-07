import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_pipeline').createTable('pipeline_stage_history', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('membership_id').notNullable().references('id').inTable('crm_pipeline.pipeline_memberships');
    table.uuid('lead_id').notNullable();
    table.varchar('pipeline').notNullable();
    table.varchar('stage_from').nullable();
    table.varchar('stage_to').notNullable();
    table.boolean('override').notNullable().defaultTo(false);
    table.uuid('triggered_by').nullable();
    table.varchar('reason').nullable();
    table.timestamp('transitioned_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Indexes
  await knex.raw(`
    CREATE INDEX pipeline_stage_history_membership_id_idx
    ON crm_pipeline.pipeline_stage_history (membership_id)
  `);

  await knex.raw(`
    CREATE INDEX pipeline_stage_history_lead_id_transitioned_at_idx
    ON crm_pipeline.pipeline_stage_history (lead_id, transitioned_at DESC)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_pipeline').dropTableIfExists('pipeline_stage_history');
}
