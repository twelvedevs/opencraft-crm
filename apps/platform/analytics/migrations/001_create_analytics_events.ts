import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS platform_analytics');

  await knex.raw(`
    CREATE TABLE platform_analytics.analytics_events (
      id          uuid        NOT NULL DEFAULT gen_random_uuid(),
      event_id    text        NOT NULL,
      event_type  text        NOT NULL,
      source      text        NOT NULL,
      entity_type text,
      entity_id   text,
      dimensions  jsonb       NOT NULL DEFAULT '{}',
      properties  jsonb       NOT NULL DEFAULT '{}',
      occurred_at timestamptz NOT NULL,
      ingested_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (event_id),
      PRIMARY KEY (id, occurred_at)
    ) PARTITION BY RANGE (occurred_at)
  `);

  await knex.raw(`
    CREATE TABLE platform_analytics.analytics_events_default
      PARTITION OF platform_analytics.analytics_events DEFAULT
  `);

  await knex.raw(`
    CREATE INDEX analytics_events_type_occurred_idx
      ON platform_analytics.analytics_events (event_type, occurred_at)
  `);

  await knex.raw(`
    CREATE INDEX analytics_events_dimensions_gin_idx
      ON platform_analytics.analytics_events USING GIN (dimensions)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS platform_analytics.analytics_events_default');
  await knex.raw('DROP TABLE IF EXISTS platform_analytics.analytics_events');
}
