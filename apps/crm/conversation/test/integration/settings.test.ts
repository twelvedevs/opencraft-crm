import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Knex } from 'knex';
import {
  HAS_DB,
  getDb,
  runMigrations,
  cleanup,
  truncateTables,
  LOCATION_ID,
  USER_ID,
} from './helpers.js';

describe.skipIf(!HAS_DB)('settings routes (integration)', () => {
  let db: Knex;
  let app: Awaited<ReturnType<typeof import('../../src/app.js').buildApp>>;

  beforeAll(async () => {
    await runMigrations();
    db = getDb();

    const { EventBusImpl, MockDriver } = await import('@ortho/event-bus');
    const driver = new MockDriver();
    const bus = new EventBusImpl(driver);
    const { buildApp } = await import('../../src/app.js');
    app = await buildApp(db, bus);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
  });

  const managerHeaders = {
    'x-internal-api-key': 'test-key',
    'x-user-id': USER_ID,
    'x-user-role': 'marketing_manager',
    'x-user-locations': '',
  };

  const agentHeaders = {
    'x-internal-api-key': 'test-key',
    'x-user-id': USER_ID,
    'x-user-role': 'call_center_agent',
    'x-user-locations': LOCATION_ID,
  };

  async function insertSettings(overrides: Record<string, unknown> = {}) {
    const [row] = await db('location_conversation_settings')
      .insert({
        location_id: LOCATION_ID,
        inactivity_days: 30,
        agent_mode_enabled: false,
        agent_max_exchanges: 3,
        ...overrides,
      })
      .returning('*');
    return row;
  }

  // ─── GET /conversations/settings/locations/:id ────────────────────────

  it('GET settings returns 403 for call_center_agent', async () => {
    await insertSettings();

    const res = await app.inject({
      method: 'GET',
      url: `/conversations/settings/locations/${LOCATION_ID}`,
      headers: agentHeaders,
    });

    expect(res.statusCode).toBe(403);
  });

  it('GET settings returns 404 when not configured', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/conversations/settings/locations/${LOCATION_ID}`,
      headers: managerHeaders,
    });

    expect(res.statusCode).toBe(404);
  });

  it('GET settings returns 200 with settings for marketing_manager', async () => {
    await insertSettings({ inactivity_days: 14 });

    const res = await app.inject({
      method: 'GET',
      url: `/conversations/settings/locations/${LOCATION_ID}`,
      headers: managerHeaders,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().inactivity_days).toBe(14);
  });

  // ─── PATCH /conversations/settings/locations/:id — 422 validation ────

  it('PATCH with agent_mode_enabled:true returns 422 when location_phone is missing', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/conversations/settings/locations/${LOCATION_ID}`,
      headers: managerHeaders,
      payload: { agent_mode_enabled: true },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe('unprocessable');
    expect(body.reason).toMatch(/location_phone/);
  });

  it('PATCH with agent_mode_enabled:true returns 422 when practice_number is missing', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/conversations/settings/locations/${LOCATION_ID}`,
      headers: managerHeaders,
      payload: { agent_mode_enabled: true, location_phone: '+15551234567' },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe('unprocessable');
    expect(body.reason).toMatch(/practice_number/);
  });

  it('PATCH with agent_mode_enabled:true succeeds when both phone fields provided', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/conversations/settings/locations/${LOCATION_ID}`,
      headers: managerHeaders,
      payload: {
        agent_mode_enabled: true,
        location_phone: '+15551234567',
        practice_number: '+15559876543',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agent_mode_enabled).toBe(true);
  });

  it('PATCH with agent_mode_enabled:true succeeds when phones are already set in DB', async () => {
    await insertSettings({
      location_phone: '+15551234567',
      practice_number: '+15559876543',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/conversations/settings/locations/${LOCATION_ID}`,
      headers: managerHeaders,
      payload: { agent_mode_enabled: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().agent_mode_enabled).toBe(true);
  });

  it('PATCH returns 403 for call_center_agent', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/conversations/settings/locations/${LOCATION_ID}`,
      headers: agentHeaders,
      payload: { inactivity_days: 7 },
    });

    expect(res.statusCode).toBe(403);
  });
});
