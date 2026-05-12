import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Campaign sends — one row per Email Service job (one per location × send phase/variant)
  await knex.schema.withSchema('crm_campaigns').createTable('campaign_sends', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('campaign_id').notNullable().references('id').inTable('crm_campaigns.campaigns');
    table.text('location_id').notNullable();
    table.text('variant').nullable();
    table.text('subject_used').notNullable();
    table.uuid('email_job_id').nullable();
    table.text('email_job_ref').notNullable().unique();
    table.text('status').notNullable().defaultTo('pending');
    table.integer('total_recipients').notNullable().defaultTo(0);
    table.integer('sent_count').notNullable().defaultTo(0);
    table.integer('failed_count').notNullable().defaultTo(0);
    table.timestamp('started_at', { useTz: true }).nullable();
    table.timestamp('completed_at', { useTz: true }).nullable();
  });

  await knex.raw('CREATE INDEX campaign_sends_campaign_id_status_idx ON crm_campaigns.campaign_sends (campaign_id, status)');
  await knex.raw('CREATE INDEX campaign_sends_campaign_id_variant_idx ON crm_campaigns.campaign_sends (campaign_id, variant)');
  await knex.raw('CREATE INDEX campaign_sends_email_job_id_idx ON crm_campaigns.campaign_sends (email_job_id)');

  // Campaign recipients — lead → campaign mapping for 7-day conversion attribution
  await knex.schema.withSchema('crm_campaigns').createTable('campaign_recipients', (table) => {
    table.uuid('campaign_id').notNullable().references('id').inTable('crm_campaigns.campaigns');
    table.text('lead_id').notNullable();
    table.text('email').notNullable();
    table.text('location_id').notNullable();
    table.text('variant').nullable();
    table.timestamp('sent_at', { useTz: true }).nullable();
    table.primary(['campaign_id', 'lead_id']);
  });

  await knex.raw('CREATE INDEX campaign_recipients_lead_id_sent_at_idx ON crm_campaigns.campaign_recipients (lead_id, sent_at)');
  await knex.raw('CREATE INDEX campaign_recipients_campaign_id_idx ON crm_campaigns.campaign_recipients (campaign_id)');
  await knex.raw('CREATE INDEX campaign_recipients_campaign_id_variant_idx ON crm_campaigns.campaign_recipients (campaign_id, variant)');

  // Campaign conversions — first qualifying stage change within 7 days of campaign send
  await knex.schema.withSchema('crm_campaigns').createTable('campaign_conversions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('campaign_id').notNullable().references('id').inTable('crm_campaigns.campaigns');
    table.text('lead_id').notNullable();
    table.text('stage_to').notNullable();
    table.text('pipeline').notNullable();
    table.timestamp('converted_at', { useTz: true }).notNullable();
    table.unique(['campaign_id', 'lead_id']);
  });

  await knex.raw('CREATE INDEX campaign_conversions_campaign_id_idx ON crm_campaigns.campaign_conversions (campaign_id)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_campaigns').dropTableIfExists('campaign_conversions');
  await knex.schema.withSchema('crm_campaigns').dropTableIfExists('campaign_recipients');
  await knex.schema.withSchema('crm_campaigns').dropTableIfExists('campaign_sends');
}
