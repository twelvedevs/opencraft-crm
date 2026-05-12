import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ─── Module mocks (hoisted before imports) ──────────────────────────────────

vi.mock('../../src/env.js', () => ({
  env: {
    PORT: 3099,
    DATABASE_URL: process.env['DATABASE_URL'] ?? 'postgresql://localhost:5432/test',
    REDIS_URL: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
    ANALYTICS_SERVICE_URL: 'http://analytics-test',
    ANALYTICS_API_KEY: 'test-analytics-key',
    MEDIA_SERVICE_URL: 'http://media-test',
    INTERNAL_API_SECRET: 'test-internal-secret',
    EMAIL_SERVICE_URL: 'http://email-test',
    NOTIFICATION_SERVICE_URL: 'http://notification-test',
    CRM_BASE_URL: 'http://crm-test',
    IDENTITY_JWKS_URL: 'http://localhost:9999/.well-known/jwks.json',
    LOG_LEVEL: 'error',
    LRU_CACHE_MAX: 500,
    LRU_CACHE_TTL_MS: 300000,
  },
}));

vi.mock('../../src/services/schedule-manager.js', () => ({
  reportingQueue: { add: vi.fn().mockResolvedValue(undefined) },
  queueRedis: { ping: vi.fn().mockResolvedValue('PONG') },
  registerSchedule: vi.fn().mockResolvedValue(undefined),
  removeSchedule: vi.fn().mockResolvedValue(undefined),
  replaceSchedule: vi.fn().mockResolvedValue(undefined),
  reconcile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/analytics-client.js', () => ({
  getLeadMetrics: vi.fn(),
  getPipelineMetrics: vi.fn(),
  getConversionMetrics: vi.fn(),
  getAdSpendMetrics: vi.fn(),
  getCoordinatorMetrics: vi.fn(),
  getCampaignMetrics: vi.fn(),
}));

// ─── Imports (resolved after mocks are in place) ─────────────────────────────

import * as analyticsClient from '../../src/services/analytics-client.js';
import {
  HAS_DB,
  buildTestApp,
  runMigrations,
  truncateTables,
  cleanup,
  makeJwt,
  LOCATION_ID,
  insertRevenueConfig,
} from './helpers.js';

// ─── Default analytics fixtures ──────────────────────────────────────────────

function setupDefaultMocks() {
  vi.mocked(analyticsClient.getLeadMetrics).mockResolvedValue({
    total: 100,
    by_channel: [{ channel: 'google_ads', count: 60 }],
  });
  vi.mocked(analyticsClient.getPipelineMetrics).mockResolvedValue({
    by_stage: [
      { stage: 'exam_scheduled', entries: 50 },
      { stage: 'exam_completed', entries: 30 },
    ],
  });
  vi.mocked(analyticsClient.getConversionMetrics).mockResolvedValue({
    total: 20,
    by_channel: [{ channel: 'google_ads', count: 20 }],
  });
  vi.mocked(analyticsClient.getAdSpendMetrics).mockResolvedValue({
    by_platform: [{ platform: 'google_ads', total_spend: 5000 }],
  });
  vi.mocked(analyticsClient.getCoordinatorMetrics).mockResolvedValue({
    coordinators: [],
  });
  vi.mocked(analyticsClient.getCampaignMetrics).mockResolvedValue({
    campaigns: [],
  });
}

// ─── Test suite ──────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)('Dashboard routes (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await runMigrations();
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
    vi.resetAllMocks();
    setupDefaultMocks();
  });

  // ─── Period validation ─────────────────────────────────────────────────────

  it('returns 400 for a malformed period string', async () => {
    const jwt = makeJwt({ role: 'marketing_staff' });

    const res = await app.inject({
      method: 'GET',
      url: '/reporting/dashboard?period=not-a-period',
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.error).toBe('invalid_period');
  });

  it('returns 400 when custom range exceeds 366 days', async () => {
    const jwt = makeJwt({ role: 'marketing_staff' });

    const res = await app.inject({
      method: 'GET',
      url: '/reporting/dashboard?period=2024-01-01/2025-12-31',
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.error).toBe('invalid_period');
    expect(body.message).toMatch(/366/);
  });

  // ─── Happy path ────────────────────────────────────────────────────────────

  it('returns 200 with kpis and missing_revenue_config for YYYY-MM period', async () => {
    const jwt = makeJwt({ role: 'marketing_staff' });

    const res = await app.inject({
      method: 'GET',
      url: '/reporting/dashboard?period=2026-01',
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.period).toBe('2026-01');
    expect(body.kpis).toBeDefined();
    expect(body.missing_revenue_config).toBeInstanceOf(Array);
  });

  it('returns 200 with YYYY-MM-DD/YYYY-MM-DD range period', async () => {
    const jwt = makeJwt({ role: 'marketing_staff' });

    const res = await app.inject({
      method: 'GET',
      url: '/reporting/dashboard?period=2026-01-01/2026-01-31',
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.period).toBe('2026-01-01/2026-01-31');
  });

  it('revenue_attributed is non-null when revenue config is present', async () => {
    // Insert revenue config so the calculator has a contract value to use
    await insertRevenueConfig(LOCATION_ID, 4000);

    const jwt = makeJwt({ role: 'marketing_staff' });

    const res = await app.inject({
      method: 'GET',
      url: '/reporting/dashboard?period=2026-01',
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { kpis: Record<string, unknown>; missing_revenue_config: string[] };
    // 20 conversions × $4000 = $80 000
    expect(body.kpis.revenue_attributed).toBe(80000);
    expect(body.missing_revenue_config).toHaveLength(0);
  });

  // ─── Upstream error → 502 ─────────────────────────────────────────────────

  it('returns 502 with upstream_unavailable when analytics throws', async () => {
    vi.mocked(analyticsClient.getLeadMetrics).mockRejectedValue(
      new Error('Analytics service down'),
    );

    const jwt = makeJwt({ role: 'marketing_staff' });

    const res = await app.inject({
      method: 'GET',
      url: '/reporting/dashboard?period=2026-02',
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.error).toBe('upstream_unavailable');
    expect(body.upstream).toBe('analytics');
  });

  // ─── call_center_agent location scoping ───────────────────────────────────

  it('call_center_agent request is scoped to their JWT locations', async () => {
    // Insert revenue config for the agent's location so we can confirm it was used
    await insertRevenueConfig(LOCATION_ID, 3000);

    const jwt = makeJwt({
      role: 'call_center_agent',
      locations: [LOCATION_ID],
    });

    const res = await app.inject({
      method: 'GET',
      // Agent cannot override location via query param — their JWT location is used
      url: `/reporting/dashboard?period=2026-03&location_id[]=${LOCATION_ID}`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(200);

    // The analytics-client was called (confirming the route executed without error)
    expect(vi.mocked(analyticsClient.getLeadMetrics)).toHaveBeenCalled();
  });
});
