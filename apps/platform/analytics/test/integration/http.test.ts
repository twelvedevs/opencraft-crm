import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import type { Queue } from 'bullmq';

const DB_URL = process.env['DATABASE_URL'];

describe.skipIf(!DB_URL)('Analytics Service — HTTP integration', () => {
  let pool: Pool;
  let app: FastifyInstance;

  // Minimal BullMQ Queue mock — only admin routes exercise the queue
  const mockQueue = {
    add: vi.fn().mockResolvedValue({ id: 'mock-job-id' }),
    getJob: vi.fn().mockResolvedValue(null),
  } as unknown as Queue;

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

    // Rollup tables required by named metric routes registered in buildApp
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

    const { buildApp } = await import('../../src/app.js');
    app = await buildApp(pool, mockQueue);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM platform_analytics.analytics_events');
  });

  /* ------------------------------------------------------------------ */
  /*  Health / readiness                                                  */
  /* ------------------------------------------------------------------ */

  it('GET /health → 200 { status: "ok" }', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /ready → 200 { status: "ready" } with live DB connection', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
  });

  /* ------------------------------------------------------------------ */
  /*  POST /analytics/query                                               */
  /* ------------------------------------------------------------------ */

  it('POST /analytics/query → { rows, total, truncated } response shape', async () => {
    // Seed one event row directly into the default partition
    await pool.query(
      `INSERT INTO platform_analytics.analytics_events_default
         (event_id, event_type, source, dimensions, properties, occurred_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      ['http-int-evt-001', 'lead.created', 'lead-service', '{"channel":"web"}', '{}'],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/analytics/query',
      payload: {
        event_type: 'lead.created',
        aggregate: 'count',
        period: { from: '2026-01-01', to: '2026-12-31' },
        granularity: 'total',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: unknown[]; total: number; truncated: boolean };
    expect(Array.isArray(body.rows)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(typeof body.truncated).toBe('boolean');
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  it('POST /analytics/query → 400 when event_type is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/analytics/query',
      payload: {
        aggregate: 'count',
        period: { from: '2026-01-01', to: '2026-12-31' },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /analytics/query → 400 when aggregate is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/analytics/query',
      payload: {
        event_type: 'lead.created',
        period: { from: '2026-01-01', to: '2026-12-31' },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /analytics/query returns empty rows when no matching events', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/analytics/query',
      payload: {
        event_type: 'nonexistent.event',
        aggregate: 'count',
        period: { from: '2026-01-01', to: '2026-12-31' },
        granularity: 'total',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: unknown[]; total: number; truncated: boolean };
    expect(body.total).toBe(0);
    expect(body.truncated).toBe(false);
  });
});
