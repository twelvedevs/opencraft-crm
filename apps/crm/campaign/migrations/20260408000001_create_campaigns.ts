import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_campaigns').createTable('campaigns', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('name').notNullable();
    table.text('status').notNullable().defaultTo('draft');
    table.text('template_id').notNullable();
    table.text('subject').nullable();
    table.uuid('segment_id').nullable();
    table.jsonb('audience_filter').nullable();
    table.uuid('audience_snapshot_id').nullable();
    table.timestamp('scheduled_for', { useTz: true }).nullable();
    table.text('orchestrate_job_id').nullable();

    // A/B config
    table.boolean('ab_enabled').notNullable().defaultTo(false);
    table.text('ab_mode').nullable();
    table.integer('ab_test_split_pct').nullable();
    table.integer('ab_winner_delay_hours').notNullable().defaultTo(4);
    table.text('ab_variant_a_subject').nullable();
    table.text('ab_variant_b_subject').nullable();
    table.text('ab_phase').nullable();
    table.text('ab_winner').nullable();
    table.timestamp('ab_decision_at', { useTz: true }).nullable();
    table.integer('ab_opens_a').notNullable().defaultTo(0);
    table.integer('ab_opens_b').notNullable().defaultTo(0);
    table.text('ab_winner_job_id').nullable();

    // Approval
    table.uuid('created_by').notNullable();
    table.uuid('approved_by').nullable();
    table.timestamp('approved_at', { useTz: true }).nullable();

    table.timestamp('sent_at', { useTz: true }).nullable();
    table.timestamp('completed_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // CHECK constraints
  await knex.raw(`
    ALTER TABLE crm_campaigns.campaigns
    ADD CONSTRAINT campaign_subject_check CHECK (
      (ab_enabled = false AND subject IS NOT NULL
        AND ab_variant_a_subject IS NULL AND ab_variant_b_subject IS NULL)
      OR
      (ab_enabled = true AND subject IS NULL
        AND ab_variant_a_subject IS NOT NULL AND ab_variant_b_subject IS NOT NULL)
    )
  `);

  await knex.raw(`
    ALTER TABLE crm_campaigns.campaigns
    ADD CONSTRAINT campaign_audience_check CHECK (
      (segment_id IS NOT NULL AND audience_filter IS NULL) OR
      (segment_id IS NULL AND audience_filter IS NOT NULL)
    )
  `);

  // Indexes
  await knex.raw('CREATE INDEX campaigns_status_idx ON crm_campaigns.campaigns (status)');
  await knex.raw(`
    CREATE INDEX campaigns_scheduled_for_status_idx
    ON crm_campaigns.campaigns (scheduled_for, status)
    WHERE status = 'scheduled'
  `);
  await knex.raw(`
    CREATE INDEX campaigns_ab_phase_idx
    ON crm_campaigns.campaigns (ab_phase)
    WHERE ab_phase = 'testing'
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_campaigns').dropTableIfExists('campaigns');
}
