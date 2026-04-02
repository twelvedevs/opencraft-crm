import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE platform_analytics.metrics_leads_daily (
      date        date    NOT NULL,
      location_id text    NOT NULL,
      channel     text    NOT NULL,
      count       int     NOT NULL DEFAULT 0,
      archived    int     NOT NULL DEFAULT 0,
      UNIQUE (date, location_id, channel)
    )
  `);

  await knex.raw(`
    CREATE TABLE platform_analytics.metrics_pipeline_daily (
      date        date    NOT NULL,
      location_id text    NOT NULL,
      pipeline    text    NOT NULL,
      stage       text    NOT NULL,
      entries     int     NOT NULL DEFAULT 0,
      UNIQUE (date, location_id, pipeline, stage)
    )
  `);

  await knex.raw(`
    CREATE TABLE platform_analytics.metrics_conversions_daily (
      date        date    NOT NULL,
      location_id text    NOT NULL,
      channel     text    NOT NULL,
      count       int     NOT NULL DEFAULT 0,
      UNIQUE (date, location_id, channel)
    )
  `);

  await knex.raw(`
    CREATE TABLE platform_analytics.metrics_messages_daily (
      date        date    NOT NULL,
      location_id text    NOT NULL,
      delivered   int     NOT NULL DEFAULT 0,
      failed      int     NOT NULL DEFAULT 0,
      opt_outs    int     NOT NULL DEFAULT 0,
      UNIQUE (date, location_id)
    )
  `);

  // campaign_name is a display hint only — queries must always GROUP BY campaign_id,
  // never campaign_name, to avoid fan-out from name changes over time.
  await knex.raw(`
    CREATE TABLE platform_analytics.metrics_ad_spend_daily (
      date          date           NOT NULL,
      platform      text           NOT NULL,
      location_id   text           NOT NULL,
      campaign_id   text           NOT NULL,
      campaign_name text           NOT NULL DEFAULT '',
      impressions   int            NOT NULL DEFAULT 0,
      clicks        int            NOT NULL DEFAULT 0,
      spend         numeric(12,2)  NOT NULL DEFAULT 0,
      UNIQUE (date, platform, location_id, campaign_id)
    )
  `);

  await knex.raw(`
    CREATE TABLE platform_analytics.metrics_campaigns_daily (
      date        date    NOT NULL,
      campaign_id text    NOT NULL,
      location_id text    NOT NULL,
      sent        int     NOT NULL DEFAULT 0,
      delivered   int     NOT NULL DEFAULT 0,
      opened      int     NOT NULL DEFAULT 0,
      clicked     int     NOT NULL DEFAULT 0,
      UNIQUE (date, campaign_id, location_id)
    )
  `);

  await knex.raw(`
    CREATE TABLE platform_analytics.metrics_referrals_daily (
      date        date    NOT NULL,
      location_id text    NOT NULL,
      count       int     NOT NULL DEFAULT 0,
      UNIQUE (date, location_id)
    )
  `);

  await knex.raw(`
    CREATE TABLE platform_analytics.metrics_coordinators_daily (
      date                  date    NOT NULL,
      location_id           text    NOT NULL,
      coordinator_id        text    NOT NULL,
      response_time_sum     int     NOT NULL DEFAULT 0,
      response_time_count   int     NOT NULL DEFAULT 0,
      time_in_stage_sum     int     NOT NULL DEFAULT 0,
      time_in_stage_count   int     NOT NULL DEFAULT 0,
      UNIQUE (date, location_id, coordinator_id)
    )
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS platform_analytics.metrics_coordinators_daily');
  await knex.raw('DROP TABLE IF EXISTS platform_analytics.metrics_referrals_daily');
  await knex.raw('DROP TABLE IF EXISTS platform_analytics.metrics_campaigns_daily');
  await knex.raw('DROP TABLE IF EXISTS platform_analytics.metrics_ad_spend_daily');
  await knex.raw('DROP TABLE IF EXISTS platform_analytics.metrics_messages_daily');
  await knex.raw('DROP TABLE IF EXISTS platform_analytics.metrics_conversions_daily');
  await knex.raw('DROP TABLE IF EXISTS platform_analytics.metrics_pipeline_daily');
  await knex.raw('DROP TABLE IF EXISTS platform_analytics.metrics_leads_daily');
}
