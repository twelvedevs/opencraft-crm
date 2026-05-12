import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_pipeline').createTable('pipeline_memberships', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('lead_id').notNullable();
    table.uuid('location_id').notNullable();
    table.varchar('pipeline').notNullable();
    table.varchar('stage').notNullable();
    table.varchar('status').notNullable().defaultTo('active');
    table.timestamp('entered_stage_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('timeout_at', { useTz: true }).nullable();
    table.varchar('previous_stage').nullable();
    table.boolean('last_transition_override').notNullable().defaultTo(false);
    table.timestamp('closed_at', { useTz: true }).nullable();
    table.varchar('closed_reason').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Check constraints
  await knex.raw(`
    ALTER TABLE crm_pipeline.pipeline_memberships
    ADD CONSTRAINT pipeline_memberships_pipeline_check
    CHECK (pipeline IN ('new_patient','in_treatment','in_retention'))
  `);

  await knex.raw(`
    ALTER TABLE crm_pipeline.pipeline_memberships
    ADD CONSTRAINT pipeline_memberships_status_check
    CHECK (status IN ('active','closed','archived'))
  `);

  await knex.raw(`
    ALTER TABLE crm_pipeline.pipeline_memberships
    ADD CONSTRAINT pipeline_memberships_closed_reason_check
    CHECK (closed_reason IN ('converted','archived','manual','import','import_undo'))
  `);

  // Unique partial index: one active membership per lead per pipeline
  await knex.raw(`
    CREATE UNIQUE INDEX pipeline_memberships_lead_pipeline_active_idx
    ON crm_pipeline.pipeline_memberships (lead_id, pipeline)
    WHERE status = 'active'
  `);

  // Composite indexes
  await knex.raw(`
    CREATE INDEX pipeline_memberships_pipeline_stage_status_timeout_idx
    ON crm_pipeline.pipeline_memberships (pipeline, stage, status, timeout_at)
  `);

  await knex.raw(`
    CREATE INDEX pipeline_memberships_location_pipeline_stage_status_idx
    ON crm_pipeline.pipeline_memberships (location_id, pipeline, stage, status)
  `);

  await knex.raw(`
    CREATE INDEX pipeline_memberships_lead_id_idx
    ON crm_pipeline.pipeline_memberships (lead_id)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_pipeline').dropTableIfExists('pipeline_memberships');
}
