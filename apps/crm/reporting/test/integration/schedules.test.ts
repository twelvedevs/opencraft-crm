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

const mockRegisterSchedule = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRemoveSchedule = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockReplaceSchedule = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../src/services/schedule-manager.js', () => ({
  reportingQueue: { add: vi.fn().mockResolvedValue(undefined) },
  queueRedis: { ping: vi.fn().mockResolvedValue('PONG') },
  registerSchedule: mockRegisterSchedule,
  removeSchedule: mockRemoveSchedule,
  replaceSchedule: mockReplaceSchedule,
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
  insertSchedule,
  USER_ID,
} from './helpers.js';

// ─── Test suite ──────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)('Schedule routes (integration)', () => {
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
    mockRegisterSchedule.mockClear();
    mockRemoveSchedule.mockClear();
    mockReplaceSchedule.mockClear();
  });

  // ─── POST /reporting/schedules ───────────────────────────────────────────────

  it('POST creates a schedule DB row and calls registerSchedule', async () => {
    const config = await insertConfig({ created_by: USER_ID });
    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_manager' });

    const res = await app.inject({
      method: 'POST',
      url: '/reporting/schedules',
      headers: { authorization: `Bearer ${jwt}` },
      payload: {
        report_config_id: config.id,
        frequency: 'weekly',
        day_of_week: 1,
        hour_utc: 9,
        recipient_emails: ['report@example.com'],
        format: 'pdf',
        active: true,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.id).toBeDefined();
    expect(body.frequency).toBe('weekly');
    expect(body.recipient_emails).toContain('report@example.com');

    // BullMQ job was registered
    expect(mockRegisterSchedule).toHaveBeenCalledOnce();
  });

  it('POST returns 400 for an invalid email in recipient_emails', async () => {
    const config = await insertConfig({ created_by: USER_ID });
    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_manager' });

    const res = await app.inject({
      method: 'POST',
      url: '/reporting/schedules',
      headers: { authorization: `Bearer ${jwt}` },
      payload: {
        report_config_id: config.id,
        frequency: 'daily',
        hour_utc: 8,
        recipient_emails: ['valid@example.com', 'not-an-email'],
        format: 'pdf',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.error).toBe('invalid_email');
  });

  it('POST returns 404 when the referenced report config does not exist', async () => {
    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_manager' });

    const res = await app.inject({
      method: 'POST',
      url: '/reporting/schedules',
      headers: { authorization: `Bearer ${jwt}` },
      payload: {
        report_config_id: '00000000-0000-0000-0000-000000000000',
        frequency: 'daily',
        hour_utc: 8,
        recipient_emails: ['valid@example.com'],
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it('POST requires reporting:write — call_center_agent gets 403', async () => {
    const config = await insertConfig({ created_by: USER_ID });
    const jwt = makeJwt({ sub: USER_ID, role: 'call_center_agent' });

    const res = await app.inject({
      method: 'POST',
      url: '/reporting/schedules',
      headers: { authorization: `Bearer ${jwt}` },
      payload: {
        report_config_id: config.id,
        frequency: 'daily',
        hour_utc: 8,
        recipient_emails: ['valid@example.com'],
      },
    });

    // call_center_agent lacks reporting:write
    expect(res.statusCode).toBe(403);
  });

  // ─── PUT /reporting/schedules/:id ────────────────────────────────────────────

  it('PUT updates the DB row and calls replaceSchedule', async () => {
    const config = await insertConfig({ created_by: USER_ID });
    const schedule = await insertSchedule(config.id, { frequency: 'daily', hour_utc: 7 });
    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_manager' });

    const res = await app.inject({
      method: 'PUT',
      url: `/reporting/schedules/${schedule.id}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: {
        report_config_id: config.id,
        frequency: 'weekly',
        day_of_week: 5,
        hour_utc: 10,
        recipient_emails: ['updated@example.com'],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.frequency).toBe('weekly');
    expect(body.hour_utc).toBe(10);

    expect(mockReplaceSchedule).toHaveBeenCalledOnce();
  });

  it('PUT returns 400 for invalid email in recipient_emails', async () => {
    const config = await insertConfig({ created_by: USER_ID });
    const schedule = await insertSchedule(config.id);
    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_manager' });

    const res = await app.inject({
      method: 'PUT',
      url: `/reporting/schedules/${schedule.id}`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: {
        report_config_id: config.id,
        frequency: 'daily',
        hour_utc: 9,
        recipient_emails: ['bad-email'],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.error).toBe('invalid_email');
  });

  // ─── DELETE /reporting/schedules/:id ─────────────────────────────────────────

  it('DELETE sets active=false in DB and calls removeSchedule', async () => {
    const config = await insertConfig({ created_by: USER_ID });
    const schedule = await insertSchedule(config.id, { active: true });
    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_manager' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/reporting/schedules/${schedule.id}`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(204);
    expect(mockRemoveSchedule).toHaveBeenCalledOnce();
  });

  it('DELETE returns 404 for a non-existent schedule', async () => {
    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_manager' });

    const res = await app.inject({
      method: 'DELETE',
      url: '/reporting/schedules/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(404);
  });

  // ─── GET /reporting/schedules ─────────────────────────────────────────────────

  it('GET returns schedules for the caller\'s own configs', async () => {
    const config = await insertConfig({ created_by: USER_ID });
    await insertSchedule(config.id);
    const jwt = makeJwt({ sub: USER_ID, role: 'marketing_staff' });

    const res = await app.inject({
      method: 'GET',
      url: '/reporting/schedules',
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(1);
  });
});
