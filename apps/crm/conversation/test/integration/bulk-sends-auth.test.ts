import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import nock from 'nock';
import type { Knex } from 'knex';
import {
  HAS_DB,
  getDb,
  runMigrations,
  cleanup,
  truncateTables,
  LOCATION_ID,
  USER_ID,
  createMockQueue,
} from './helpers.js';

describe.skipIf(!HAS_DB)('bulk-sends auth (integration)', () => {
  let db: Knex;
  let app: Awaited<ReturnType<typeof import('../../src/app.js').buildApp>>;

  beforeAll(async () => {
    await runMigrations();
    db = getDb();

    const { EventBusImpl, MockDriver } = await import('@ortho/event-bus');
    const driver = new MockDriver();
    const bus = new EventBusImpl(driver);
    const { buildApp } = await import('../../src/app.js');
    const bulkSendQueue = createMockQueue();
    app = await buildApp(db, bus, { bulkSendQueue: bulkSendQueue as never });
    await app.ready();
  });

  afterAll(async () => {
    nock.cleanAll();
    nock.restore();
    await app.close();
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
    nock.cleanAll();
  });

  const bulkPayload = {
    segment: { status: 'active' },
    body: 'Hello from bulk SMS',
    location_id: LOCATION_ID,
  };

  it('returns 403 for call_center_agent role', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/conversations/bulk-sends',
      headers: {
        'x-internal-api-key': 'test-key',
        'x-user-id': USER_ID,
        'x-user-role': 'call_center_agent',
        'x-user-locations': LOCATION_ID,
      },
      payload: bulkPayload,
    });

    expect(res.statusCode).toBe(403);
  });

  it('returns 403 for call_center_manager accessing a different location', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/conversations/bulk-sends',
      headers: {
        'x-internal-api-key': 'test-key',
        'x-user-id': USER_ID,
        'x-user-role': 'call_center_manager',
        'x-user-locations': '00000000-0000-0000-0000-000000000999', // different location
      },
      payload: bulkPayload,
    });

    expect(res.statusCode).toBe(403);
  });

  it('returns 202 for call_center_manager with matching location', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/conversations/bulk-sends',
      headers: {
        'x-internal-api-key': 'test-key',
        'x-user-id': USER_ID,
        'x-user-role': 'call_center_manager',
        'x-user-locations': LOCATION_ID,
      },
      payload: bulkPayload,
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toHaveProperty('job_id');
  });

  it('returns 202 for marketing_manager with any location', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/conversations/bulk-sends',
      headers: {
        'x-internal-api-key': 'test-key',
        'x-user-id': USER_ID,
        'x-user-role': 'marketing_manager',
        'x-user-locations': '',
      },
      payload: bulkPayload,
    });

    expect(res.statusCode).toBe(202);
  });

  it('returns 403 when no auth headers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/conversations/bulk-sends',
      headers: { 'x-internal-api-key': 'test-key' },
      payload: bulkPayload,
    });

    expect(res.statusCode).toBe(403);
  });
});
