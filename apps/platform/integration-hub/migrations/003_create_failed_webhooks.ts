import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE platform_integrations.failed_webhooks (
      id          uuid         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      platform    text         NOT NULL,
      raw_body    text         NOT NULL,
      error       text         NOT NULL,
      received_at timestamptz  NOT NULL DEFAULT now()
    )
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS platform_integrations.failed_webhooks');
}
