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
  insertRun,
  JWKS_RESPONSE,
  LOCATION_ID,
  USER_ID,
  MANAGER_ID,
} from './helpers.js';

// ─── Test suite ──────────────────────────────────────────────────────────────

const PRESIGNED_URL = 'https://s3.example.com/presigned-test-url';
const TEST_FILE_ID = 'test-file-id-001';

describe.skipIf(!HAS_DB)('Run routes (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await runMigrations();

    // Build app with a custom fetch that handles JWKS + Media Service signed-url
    app = await buildTestApp();

    // Override global fetch to also handle the Media Service signed-url endpoint
    const existingFetch = globalThis.fetch;
    globalThis.fetch = async function (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.includes('.well-known/jwks.json') || url.includes('/jwks')) {
        return new Response(JWKS_RESPONSE, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.includes('/signed-url')) {
        return new Response(JSON.stringify({ url: PRESIGNED_URL }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return existingFetch(input, init);
    } as typeof globalThis.fetch;
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
    mockQueueAdd.mockClear();
  });

  // ─── GET /reporting/runs?config_id= ──────────────────────────────────────────

  it('GET list returns runs filtered by config_id', async () => {
    const config = await insertConfig({ created_by: USER_ID });
    await insertRun(config.id, { status: 'done', triggered_by: USER_ID });
    await insertRun(config.id, { status: 'failed', triggered_by: USER_ID });

    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_staff' });

    const res = await app.inject({
      method: 'GET',
      url: `/reporting/runs?config_id=${config.id}`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(2);
  });

  it('GET list returns 400 when config_id param is missing', async () => {
    const jwt = makeJwt({ role: 'marketing_staff' });

    const res = await app.inject({
      method: 'GET',
      url: '/reporting/runs',
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.error).toBe('missing_param');
  });

  // ─── GET /reporting/runs/:id ──────────────────────────────────────────────────

  it('GET /:id returns the run', async () => {
    const config = await insertConfig({ created_by: USER_ID });
    const run = await insertRun(config.id, { status: 'done', triggered_by: USER_ID });

    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_staff' });

    const res = await app.inject({
      method: 'GET',
      url: `/reporting/runs/${run.id}`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.id).toBe(run.id);
    expect(body.status).toBe('done');
  });

  it('GET /:id returns 404 for a non-existent run', async () => {
    const jwt = makeJwt({ role: 'marketing_staff' });

    const res = await app.inject({
      method: 'GET',
      url: '/reporting/runs/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(404);
  });

  // ─── GET /reporting/runs/:id/download ────────────────────────────────────────

  it('download returns 302 redirect to the presigned URL', async () => {
    const config = await insertConfig({
      created_by: USER_ID,
      parameters: { location_ids: [LOCATION_ID] },
    });
    const run = await insertRun(config.id, {
      status: 'done',
      triggered_by: USER_ID,
      media_file_id: TEST_FILE_ID,
    });

    // marketing_manager always passes the access check
    const jwt = makeJwt({ sub: MANAGER_ID, role: 'marketing_manager' });

    const res = await app.inject({
      method: 'GET',
      url: `/reporting/runs/${run.id}/download`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe(PRESIGNED_URL);
  });

  it('download returns 409 when run has no media_file_id yet', async () => {
    const config = await insertConfig({ created_by: USER_ID });
    const run = await insertRun(config.id, { status: 'pending', triggered_by: USER_ID });

    const jwt = makeJwt({ sub: MANAGER_ID, role: 'marketing_manager' });

    const res = await app.inject({
      method: 'GET',
      url: `/reporting/runs/${run.id}/download`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.error).toBe('not_ready');
  });

  // ─── POST /reporting/runs/:id/retry ──────────────────────────────────────────

  it('retry creates a new run row and enqueues a job', async () => {
    const config = await insertConfig({ created_by: USER_ID });
    const failedRun = await insertRun(config.id, {
      status: 'failed',
      triggered_by: USER_ID,
      format: 'csv',
    });

    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_staff' });

    const res = await app.inject({
      method: 'POST',
      url: `/reporting/runs/${failedRun.id}/retry`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body) as { run_id: string };
    expect(body.run_id).toBeDefined();
    // New run_id should differ from the original
    expect(body.run_id).not.toBe(failedRun.id);

    // A new BullMQ job was enqueued
    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const [, jobData] = mockQueueAdd.mock.calls[0] as [string, Record<string, unknown>];
    expect(jobData.format).toBe('csv');
    expect(jobData.report_run_id).toBe(body.run_id);
  });

  it('retry returns 400 when the run is not in failed status', async () => {
    const config = await insertConfig({ created_by: USER_ID });
    const pendingRun = await insertRun(config.id, {
      status: 'pending',
      triggered_by: USER_ID,
    });

    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_staff' });

    const res = await app.inject({
      method: 'POST',
      url: `/reporting/runs/${pendingRun.id}/retry`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.error).toBe('invalid_state');
  });

  it('retry with done-status run returns 400', async () => {
    const config = await insertConfig({ created_by: USER_ID });
    const doneRun = await insertRun(config.id, {
      status: 'done',
      triggered_by: USER_ID,
      media_file_id: TEST_FILE_ID,
    });

    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_staff' });

    const res = await app.inject({
      method: 'POST',
      url: `/reporting/runs/${doneRun.id}/retry`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(400);
  });
});
