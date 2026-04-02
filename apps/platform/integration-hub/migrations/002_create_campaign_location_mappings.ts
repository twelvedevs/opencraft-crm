import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE platform_integrations.campaign_location_mappings (
      id            uuid  NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      account_id    uuid  NOT NULL REFERENCES platform_integrations.integration_accounts(id) ON DELETE CASCADE,
      campaign_id   text  NOT NULL,
      campaign_name text,
      location_id   text  NOT NULL,
      UNIQUE (account_id, campaign_id)
    )
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS platform_integrations.campaign_location_mappings');
}
