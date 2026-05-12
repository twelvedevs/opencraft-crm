import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ─── Module mocks ────────────────────────────────────────────────────────────

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
  getLeadMetrics: vi.fn().mockResolvedValue({ total: 0, by_channel: [] }),
  getPipelineMetrics: vi.fn().mockResolvedValue({ by_stage: [] }),
  getConversionMetrics: vi.fn().mockResolvedValue({ total: 0, by_channel: [] }),
  getAdSpendMetrics: vi.fn().mockResolvedValue({ by_platform: [] }),
  getCoordinatorMetrics: vi.fn().mockResolvedValue({ coordinators: [] }),
  getCampaignMetrics: vi.fn().mockResolvedValue({ campaigns: [] }),
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import {
  HAS_DB,
  buildTestApp,
  runMigrations,
  truncateTables,
  cleanup,
  makeJwt,
  insertRevenueConfig,
  LOCATION_ID,
  LOCATION_ID_2,
  USER_ID,
  MANAGER_ID,
} from './helpers.js';

// ─── Test suite ──────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)('Revenue config routes (integration)', () => {
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
  });

  // ─── GET /reporting/config/revenue ───────────────────────────────────────────

  it('marketing_manager GET returns all revenue configs', async () => {
    await insertRevenueConfig(LOCATION_ID, 4500);
    await insertRevenueConfig(LOCATION_ID_2, 5500);

    const jwt = makeJwt({ sub: MANAGER_ID, role: 'marketing_manager' });

    const res = await app.inject({
      method: 'GET',
      url: '/reporting/config/revenue',
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(2);
  });

  it('call_center_agent GET returns only rows for their JWT locations', async () => {
    await insertRevenueConfig(LOCATION_ID, 4500);
    await insertRevenueConfig(LOCATION_ID_2, 5500);

    // Agent has access to LOCATION_ID only
    const jwt = makeJwt({
      sub: USER_ID,
      role: 'call_center_agent',
      locations: [LOCATION_ID],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/reporting/config/revenue',
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.location_id).toBe(LOCATION_ID);
  });

  it('call_center_manager GET returns only rows for their JWT locations', async () => {
    await insertRevenueConfig(LOCATION_ID, 4500);
    await insertRevenueConfig(LOCATION_ID_2, 5500);

    const jwt = makeJwt({
      sub: USER_ID,
      role: 'call_center_manager',
      locations: [LOCATION_ID_2],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/reporting/config/revenue',
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.location_id).toBe(LOCATION_ID_2);
  });

  // ─── PUT /reporting/config/revenue/:location_id ──────────────────────────────

  it('marketing_manager PUT upserts a revenue config', async () => {
    const jwt = makeJwt({ sub: MANAGER_ID, role: 'marketing_manager' });

    const res = await app.inject({
      method: 'PUT',
      url: `/reporting/config/revenue/${LOCATION_ID}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { avg_contract_value: 6000 },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.location_id).toBe(LOCATION_ID);
    expect(body.avg_contract_value).toBe(6000);
  });

  it('marketing_manager PUT updates an existing revenue config (upsert)', async () => {
    await insertRevenueConfig(LOCATION_ID, 4000);

    const jwt = makeJwt({ sub: MANAGER_ID, role: 'marketing_manager' });

    const res = await app.inject({
      method: 'PUT',
      url: `/reporting/config/revenue/${LOCATION_ID}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { avg_contract_value: 7500 },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.avg_contract_value).toBe(7500);
  });

  it('call_center_agent PUT returns 403 (requires reporting:write)', async () => {
    const jwt = makeJwt({
      sub: USER_ID,
      role: 'call_center_agent',
      locations: [LOCATION_ID],
    });

    const res = await app.inject({
      method: 'PUT',
      url: `/reporting/config/revenue/${LOCATION_ID}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { avg_contract_value: 3000 },
    });

    expect(res.statusCode).toBe(403);
  });

  it('marketing_staff PUT returns 403 (requires reporting:write)', async () => {
    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_staff' });

    const res = await app.inject({
      method: 'PUT',
      url: `/reporting/config/revenue/${LOCATION_ID}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { avg_contract_value: 3000 },
    });

    expect(res.statusCode).toBe(403);
  });
});
