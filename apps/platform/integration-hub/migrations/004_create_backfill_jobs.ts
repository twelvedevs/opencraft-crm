import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE platform_integrations.backfill_jobs (
      id           uuid         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      account_id   uuid         NOT NULL REFERENCES platform_integrations.integration_accounts(id) ON DELETE CASCADE,
      status       text         NOT NULL DEFAULT 'active',
      from_date    date         NOT NULL,
      to_date      date         NOT NULL,
      chunks_done  integer      NOT NULL DEFAULT 0,
      chunks_total integer      NOT NULL,
      error        text,
      created_at   timestamptz  NOT NULL DEFAULT now(),
      updated_at   timestamptz  NOT NULL DEFAULT now()
    )
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS platform_integrations.backfill_jobs');
}
