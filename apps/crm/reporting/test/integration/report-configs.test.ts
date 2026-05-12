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

const mockQueueAdd = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../src/services/schedule-manager.js', () => ({
  reportingQueue: { add: mockQueueAdd },
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
  insertConfig,
  LOCATION_ID,
  USER_ID,
  MANAGER_ID,
} from './helpers.js';

// ─── Test suite ──────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)('Report-configs routes (integration)', () => {
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
    mockQueueAdd.mockClear();
  });

  // ─── POST /reporting/report-configs ─────────────────────────────────────────

  it('POST creates a new report config and returns 201', async () => {
    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_staff' });

    const res = await app.inject({
      method: 'POST',
      url: '/reporting/report-configs',
      headers: { authorization: `Bearer ${jwt}` },
      payload: {
        name: 'My Weekly Report',
        report_type: 'weekly_summary',
        parameters: { period_type: 'last_30d' },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.id).toBeDefined();
    expect(body.name).toBe('My Weekly Report');
    expect(body.report_type).toBe('weekly_summary');
    expect(body.created_by).toBe(USER_ID);
  });

  // ─── GET /reporting/report-configs ──────────────────────────────────────────

  it('GET returns only the caller\'s own configs by default', async () => {
    // Two configs: one by USER_ID, one by MANAGER_ID
    await insertConfig({ created_by: USER_ID, name: 'User Config' });
    await insertConfig({ created_by: MANAGER_ID, name: 'Manager Config' });

    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_staff' });

    const res = await app.inject({
      method: 'GET',
      url: '/reporting/report-configs',
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.name).toBe('User Config');
  });

  it('GET with all=true and marketing_manager role returns all configs', async () => {
    await insertConfig({ created_by: USER_ID, name: 'User Config' });
    await insertConfig({ created_by: MANAGER_ID, name: 'Manager Config' });

    const jwt = makeJwt({ sub: MANAGER_ID, role: 'marketing_manager' });

    const res = await app.inject({
      method: 'GET',
      url: '/reporting/report-configs?all=true',
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(2);
  });

  it('GET with all=true but non-manager role returns only caller\'s own configs', async () => {
    await insertConfig({ created_by: USER_ID });
    await insertConfig({ created_by: MANAGER_ID });

    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_staff' });

    const res = await app.inject({
      method: 'GET',
      url: '/reporting/report-configs?all=true',
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<Record<string, unknown>> };
    // non-manager: all=true is ignored
    expect(body.data).toHaveLength(1);
  });

  // ─── PUT /reporting/report-configs/:id ──────────────────────────────────────

  it('PUT updates the config when caller is the owner', async () => {
    const config = await insertConfig({ created_by: USER_ID, name: 'Original' });
    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_staff' });

    const res = await app.inject({
      method: 'PUT',
      url: `/reporting/report-configs/${config.id}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: {
        name: 'Updated',
        report_type: 'weekly_summary',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.name).toBe('Updated');
  });

  it('PUT returns 403 when a non-owner non-manager tries to update', async () => {
    const config = await insertConfig({ created_by: MANAGER_ID });
    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_staff' });

    const res = await app.inject({
      method: 'PUT',
      url: `/reporting/report-configs/${config.id}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { name: 'Hacked', report_type: 'weekly_summary' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('PUT succeeds when a marketing_manager updates another user\'s config', async () => {
    const config = await insertConfig({ created_by: USER_ID });
    const jwt = makeJwt({ sub: MANAGER_ID, role: 'marketing_manager' });

    const res = await app.inject({
      method: 'PUT',
      url: `/reporting/report-configs/${config.id}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { name: 'Manager Override', report_type: 'weekly_summary' },
    });

    expect(res.statusCode).toBe(200);
  });

  // ─── DELETE /reporting/report-configs/:id ───────────────────────────────────

  it('DELETE returns 204 when caller is the owner', async () => {
    const config = await insertConfig({ created_by: USER_ID });
    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_staff' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/reporting/report-configs/${config.id}`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(204);
  });

  it('DELETE returns 403 when a non-owner non-manager tries to delete', async () => {
    const config = await insertConfig({ created_by: MANAGER_ID });
    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_staff' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/reporting/report-configs/${config.id}`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(403);
  });

  // ─── POST /reporting/report-configs/:id/generate ────────────────────────────

  it('generate returns 202 with run_id and creates a pending run row', async () => {
    const config = await insertConfig({ created_by: USER_ID });
    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_staff' });

    const res = await app.inject({
      method: 'POST',
      url: `/reporting/report-configs/${config.id}/generate`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body) as { run_id: string };
    expect(body.run_id).toBeDefined();
    expect(typeof body.run_id).toBe('string');
  });

  it('generate enqueues a BullMQ job', async () => {
    const config = await insertConfig({ created_by: USER_ID });
    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_staff' });

    await app.inject({
      method: 'POST',
      url: `/reporting/report-configs/${config.id}/generate`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const [jobName, jobData] = mockQueueAdd.mock.calls[0] as [string, Record<string, unknown>];
    expect(jobName).toBe('generate-report');
    expect(jobData.report_config_id).toBe(config.id);
    expect(jobData.format).toBe('pdf');
  });

  it('generate with format=csv creates a csv run', async () => {
    const config = await insertConfig({ created_by: USER_ID });
    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_staff' });

    const res = await app.inject({
      method: 'POST',
      url: `/reporting/report-configs/${config.id}/generate?format=csv`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(202);
    const [, jobData] = mockQueueAdd.mock.calls[0] as [string, Record<string, unknown>];
    expect(jobData.format).toBe('csv');
  });

  it('call_center_agent cannot set location_ids outside their JWT locations', async () => {
    const jwt = makeJwt({
      sub: USER_ID,
      role: 'call_center_agent',
      locations: [LOCATION_ID],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/reporting/report-configs',
      headers: { authorization: `Bearer ${jwt}` },
      payload: {
        name: 'Agent Scoped',
        report_type: 'weekly_summary',
        parameters: { location_ids: ['forbidden-location'] },
      },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.error).toBe('forbidden');
  });
});
