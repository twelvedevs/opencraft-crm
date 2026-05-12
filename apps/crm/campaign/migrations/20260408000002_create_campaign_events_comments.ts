import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Campaign events (state transition audit log)
  await knex.schema.withSchema('crm_campaigns').createTable('campaign_events', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('campaign_id').notNullable().references('id').inTable('crm_campaigns.campaigns');
    table.text('from_status').nullable();
    table.text('to_status').notNullable();
    table.uuid('actor_id').nullable();
    table.text('comment').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw('CREATE INDEX campaign_events_campaign_id_idx ON crm_campaigns.campaign_events (campaign_id)');

  // Campaign comments (review discussion thread)
  await knex.schema.withSchema('crm_campaigns').createTable('campaign_comments', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('campaign_id').notNullable().references('id').inTable('crm_campaigns.campaigns');
    table.uuid('author_id').notNullable();
    table.text('body').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw('CREATE INDEX campaign_comments_campaign_id_idx ON crm_campaigns.campaign_comments (campaign_id)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema('crm_campaigns').dropTableIfExists('campaign_comments');
  await knex.schema.withSchema('crm_campaigns').dropTableIfExists('campaign_events');
}
