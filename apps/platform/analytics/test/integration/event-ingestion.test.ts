import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { routeEvent } from '../../src/services/event-router.js';
import type { OrthoEvent } from '@ortho/event-bus';

const DB_URL = process.env['DATABASE_URL'];

describe.skipIf(!DB_URL)('Analytics Service — event ingestion integration', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });

    await pool.query('CREATE SCHEMA IF NOT EXISTS platform_analytics');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_analytics.analytics_events (
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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_analytics.analytics_events_default
        PARTITION OF platform_analytics.analytics_events DEFAULT
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_analytics.metrics_leads_daily (
        date        date NOT NULL,
        location_id text NOT NULL,
        channel     text NOT NULL,
        count       int  NOT NULL DEFAULT 0,
        archived    int  NOT NULL DEFAULT 0,
        UNIQUE (date, location_id, channel)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_analytics.metrics_pipeline_daily (
        date        date NOT NULL,
        location_id text NOT NULL,
        pipeline    text NOT NULL,
        stage       text NOT NULL,
        entries     int  NOT NULL DEFAULT 0,
        UNIQUE (date, location_id, pipeline, stage)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_analytics.metrics_conversions_daily (
        date        date NOT NULL,
        location_id text NOT NULL,
        channel     text NOT NULL,
        count       int  NOT NULL DEFAULT 0,
        UNIQUE (date, location_id, channel)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_analytics.metrics_messages_daily (
        date        date NOT NULL,
        location_id text NOT NULL,
        delivered   int  NOT NULL DEFAULT 0,
        failed      int  NOT NULL DEFAULT 0,
        opt_outs    int  NOT NULL DEFAULT 0,
        UNIQUE (date, location_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_analytics.metrics_ad_spend_daily (
        date          date          NOT NULL,
        platform      text          NOT NULL,
        location_id   text          NOT NULL,
        campaign_id   text          NOT NULL,
        campaign_name text          NOT NULL DEFAULT '',
        impressions   int           NOT NULL DEFAULT 0,
        clicks        int           NOT NULL DEFAULT 0,
        spend         numeric(12,2) NOT NULL DEFAULT 0,
        UNIQUE (date, platform, location_id, campaign_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_analytics.metrics_campaigns_daily (
        date        date NOT NULL,
        campaign_id text NOT NULL,
        location_id text NOT NULL,
        sent        int  NOT NULL DEFAULT 0,
        delivered   int  NOT NULL DEFAULT 0,
        opened      int  NOT NULL DEFAULT 0,
        clicked     int  NOT NULL DEFAULT 0,
        UNIQUE (date, campaign_id, location_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_analytics.metrics_referrals_daily (
        date        date NOT NULL,
        location_id text NOT NULL,
        count       int  NOT NULL DEFAULT 0,
        UNIQUE (date, location_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_analytics.metrics_coordinators_daily (
        date                date NOT NULL,
        location_id         text NOT NULL,
        coordinator_id      text NOT NULL,
        response_time_sum   int  NOT NULL DEFAULT 0,
        response_time_count int  NOT NULL DEFAULT 0,
        time_in_stage_sum   int  NOT NULL DEFAULT 0,
        time_in_stage_count int  NOT NULL DEFAULT 0,
        UNIQUE (date, location_id, coordinator_id)
      )
    `);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM platform_analytics.analytics_events');
    await pool.query('DELETE FROM platform_analytics.metrics_leads_daily');
    await pool.query('DELETE FROM platform_analytics.metrics_pipeline_daily');
    await pool.query('DELETE FROM platform_analytics.metrics_conversions_daily');
    await pool.query('DELETE FROM platform_analytics.metrics_messages_daily');
    await pool.query('DELETE FROM platform_analytics.metrics_ad_spend_daily');
    await pool.query('DELETE FROM platform_analytics.metrics_campaigns_daily');
    await pool.query('DELETE FROM platform_analytics.metrics_referrals_daily');
    await pool.query('DELETE FROM platform_analytics.metrics_coordinators_daily');
  });

  /* ------------------------------------------------------------------ */
  /*  lead.created                                                        */
  /* ------------------------------------------------------------------ */

  it('lead.created → analytics_events row + metrics_leads_daily increment', async () => {
    const event: OrthoEvent = {
      event_id: 'int-evt-lead-created-001',
      event_type: 'lead.created',
      entity_type: 'lead',
      entity_id: 'lead-abc',
      payload: {
        location_id: 'loc-1',
        channel: 'google_ads',
        occurred_at: '2026-04-01T10:00:00Z',
      },
    };

    await routeEvent(event, pool);

    const evtRows = await pool.query(
      `SELECT * FROM platform_analytics.analytics_events WHERE event_id = 'int-evt-lead-created-001'`,
    );
    expect(evtRows.rows).toHaveLength(1);
    expect(evtRows.rows[0].event_type).toBe('lead.created');
    expect(evtRows.rows[0].source).toBe('lead-service');

    const rollupRows = await pool.query(
      `SELECT * FROM platform_analytics.metrics_leads_daily
       WHERE location_id = 'loc-1' AND channel = 'google_ads'`,
    );
    expect(rollupRows.rows).toHaveLength(1);
    expect(Number(rollupRows.rows[0].count)).toBe(1);
  });

  /* ------------------------------------------------------------------ */
  /*  Deduplication                                                       */
  /* ------------------------------------------------------------------ */

  it('duplicate event_id → exactly one analytics_events row, no double-count in rollup', async () => {
    const event: OrthoEvent = {
      event_id: 'int-evt-dedup-001',
      event_type: 'lead.created',
      entity_type: 'lead',
      entity_id: 'lead-xyz',
      payload: {
        location_id: 'loc-2',
        channel: 'facebook',
        occurred_at: '2026-04-01T10:00:00Z',
      },
    };

    await routeEvent(event, pool);
    await routeEvent(event, pool); // exact same event_id

    const evtRows = await pool.query(
      `SELECT * FROM platform_analytics.analytics_events WHERE event_id = 'int-evt-dedup-001'`,
    );
    expect(evtRows.rows).toHaveLength(1);

    const rollupRows = await pool.query(
      `SELECT * FROM platform_analytics.metrics_leads_daily
       WHERE location_id = 'loc-2' AND channel = 'facebook'`,
    );
    expect(rollupRows.rows).toHaveLength(1);
    expect(Number(rollupRows.rows[0].count)).toBe(1); // not double-counted
  });

  /* ------------------------------------------------------------------ */
  /*  stage-changed — dual rollup                                        */
  /* ------------------------------------------------------------------ */

  it('lead.stage_changed → metrics_pipeline_daily AND metrics_coordinators_daily when triggered_by set', async () => {
    const event: OrthoEvent = {
      event_id: 'int-evt-stage-001',
      event_type: 'lead.stage_changed',
      entity_type: 'lead',
      entity_id: 'lead-stage',
      payload: {
        location_id: 'loc-3',
        pipeline: 'new-patient',
        stage_to: 'contacted',
        triggered_by: 'coord-99',
        response_time_seconds: 120,
        time_in_stage_seconds: 600,
        occurred_at: '2026-04-01T11:00:00Z',
      },
    };

    await routeEvent(event, pool);

    const pipelineRows = await pool.query(
      `SELECT * FROM platform_analytics.metrics_pipeline_daily
       WHERE location_id = 'loc-3' AND pipeline = 'new-patient' AND stage = 'contacted'`,
    );
    expect(pipelineRows.rows).toHaveLength(1);
    expect(Number(pipelineRows.rows[0].entries)).toBe(1);

    const coordRows = await pool.query(
      `SELECT * FROM platform_analytics.metrics_coordinators_daily
       WHERE coordinator_id = 'coord-99'`,
    );
    expect(coordRows.rows).toHaveLength(1);
    expect(Number(coordRows.rows[0].response_time_sum)).toBe(120);
    expect(Number(coordRows.rows[0].response_time_count)).toBe(1);
    expect(Number(coordRows.rows[0].time_in_stage_sum)).toBe(600);
    expect(Number(coordRows.rows[0].time_in_stage_count)).toBe(1);
  });

  it('lead.stage_changed duplicate → both rollups skipped (entries remains 1)', async () => {
    const event: OrthoEvent = {
      event_id: 'int-evt-stage-dedup-001',
      event_type: 'lead.stage_changed',
      entity_type: 'lead',
      entity_id: 'lead-stage2',
      payload: {
        location_id: 'loc-5',
        pipeline: 'new-patient',
        stage_to: 'exam-scheduled',
        triggered_by: 'coord-77',
        response_time_seconds: 60,
        time_in_stage_seconds: 300,
        occurred_at: '2026-04-01T12:00:00Z',
      },
    };

    await routeEvent(event, pool);
    await routeEvent(event, pool); // duplicate

    const pipelineRows = await pool.query(
      `SELECT * FROM platform_analytics.metrics_pipeline_daily
       WHERE location_id = 'loc-5' AND stage = 'exam-scheduled'`,
    );
    expect(pipelineRows.rows).toHaveLength(1);
    expect(Number(pipelineRows.rows[0].entries)).toBe(1); // not doubled

    const coordRows = await pool.query(
      `SELECT * FROM platform_analytics.metrics_coordinators_daily
       WHERE coordinator_id = 'coord-77'`,
    );
    expect(coordRows.rows).toHaveLength(1);
    expect(Number(coordRows.rows[0].response_time_count)).toBe(1); // not doubled
  });

  /* ------------------------------------------------------------------ */
  /*  ad_spend.synced — relaxed idempotency                              */
  /* ------------------------------------------------------------------ */

  it('ad_spend.synced — same event_id twice overwrites spend, analytics_events has one row', async () => {
    function makeAdSpendEvent(spend: number): OrthoEvent {
      return {
        event_id: 'int-evt-adspend-001',
        event_type: 'ad_spend.synced',
        entity_type: 'ad-spend',
        entity_id: undefined,
        payload: {
          platform: 'google',
          location_id: 'loc-4',
          synced_date: '2026-04-01',
          occurred_at: '2026-04-01T12:00:00Z',
          records: [
            {
              campaign_id: 'camp-1',
              campaign_name: 'Spring 2026',
              impressions: 1000,
              clicks: 50,
              spend,
            },
          ],
        },
      };
    }

    await routeEvent(makeAdSpendEvent(100), pool);
    await routeEvent(makeAdSpendEvent(200), pool); // same event_id, corrected spend

    const evtRows = await pool.query(
      `SELECT * FROM platform_analytics.analytics_events WHERE event_id = 'int-evt-adspend-001'`,
    );
    expect(evtRows.rows).toHaveLength(1); // only one analytics_events row

    const spendRows = await pool.query(
      `SELECT * FROM platform_analytics.metrics_ad_spend_daily WHERE campaign_id = 'camp-1'`,
    );
    expect(spendRows.rows).toHaveLength(1);
    expect(Number(spendRows.rows[0].spend)).toBe(200); // overwritten with corrected value
  });
});
