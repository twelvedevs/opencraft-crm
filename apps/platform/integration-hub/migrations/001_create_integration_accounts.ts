import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS platform_integrations');

  await knex.raw(`
    CREATE TABLE platform_integrations.integration_accounts (
      id               uuid         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      platform         text         NOT NULL,
      account_id       text         NOT NULL,
      account_name     text,
      access_token     text         NOT NULL,
      refresh_token    text,
      token_expires_at timestamptz,
      status           text         NOT NULL DEFAULT 'active',
      last_error       text,
      last_polled_at   timestamptz,
      created_at       timestamptz  NOT NULL DEFAULT now(),
      UNIQUE (platform, account_id)
    )
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS platform_integrations.integration_accounts');
}
