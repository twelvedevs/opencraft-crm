import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Knex } from 'knex';
import {
  HAS_DB,
  getDb,
  runMigrations,
  cleanup,
  truncateTables,
  LOCATION_ID,
  LEAD_ID,
  PRACTICE_NUMBER,
  LEAD_PHONE,
  USER_ID,
} from './helpers.js';

describe.skipIf(!HAS_DB)('PATCH conversation (integration)', () => {
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

  async function insertConversation(overrides: Record<string, unknown> = {}) {
    const [row] = await db('conversations')
      .insert({
        lead_id: LEAD_ID,
        location_id: LOCATION_ID,
        practice_number: PRACTICE_NUMBER,
        lead_phone: LEAD_PHONE,
        status: 'open',
        last_message_at: new Date(),
        ...overrides,
      })
      .returning('*');
    return row;
  }

  // ─── call_center_agent cannot enable agent_mode_active ─────────────

  it('PATCH agent_mode_active:true returns 403 for call_center_agent role', async () => {
    const conversation = await insertConversation();

    const res = await app.inject({
      method: 'PATCH',
      url: `/conversations/${conversation.id}`,
      headers: {
        'x-internal-api-key': 'test-key',
        'x-user-id': USER_ID,
        'x-user-role': 'call_center_agent',
        'x-user-locations': LOCATION_ID,
      },
      payload: { agent_mode_active: true },
    });

    expect(res.statusCode).toBe(403);

    // Verify agent_mode_active unchanged
    const conv = await db('conversations').where('id', conversation.id).first();
    expect(conv.agent_mode_active).toBe(false);
  });

  // ─── marketing_manager can enable agent_mode_active ────────────────

  it('PATCH agent_mode_active:true succeeds for marketing_manager role and resets agent_exchange_count to 0', async () => {
    const conversation = await insertConversation({
      agent_mode_active: false,
      agent_exchange_count: 5,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/conversations/${conversation.id}`,
      headers: {
        'x-internal-api-key': 'test-key',
        'x-user-id': USER_ID,
        'x-user-role': 'marketing_manager',
        'x-user-locations': '', // empty = all-locations access
      },
      payload: { agent_mode_active: true },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agent_mode_active).toBe(true);
    expect(body.agent_exchange_count).toBe(0);

    // Verify in DB
    const conv = await db('conversations').where('id', conversation.id).first();
    expect(conv.agent_mode_active).toBe(true);
    expect(conv.agent_exchange_count).toBe(0);
  });
});
