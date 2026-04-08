import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
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

describe.skipIf(!HAS_DB)('outbound message flows (integration)', () => {
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
    nock.cleanAll();
    nock.restore();
    await app.close();
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  const AUTH_HEADERS = {
    'x-internal-api-key': 'test-key',
    'x-user-id': USER_ID,
    'x-user-role': 'call_center_agent',
    'x-user-locations': LOCATION_ID,
  };

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

  // ─── POST /conversations/:id/messages sends via Messaging Service ──

  it('POST /conversations/:id/messages sends via Messaging Service and stores with status queued', async () => {
    const conversation = await insertConversation();
    const messagingMsgId = '00000000-0000-0000-0000-000000000abc';

    const messagingScope = nock('http://localhost:3001')
      .post('/messages/send')
      .reply(200, { message_id: messagingMsgId });

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${conversation.id}/messages`,
      headers: AUTH_HEADERS,
      payload: { body: 'Hello from coordinator' },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.messageId).toBeDefined();
    expect(json.status).toBe('queued');

    // Verify message stored in DB
    const messages = await db('conversation_messages')
      .where('conversation_id', conversation.id)
      .select('*');
    expect(messages).toHaveLength(1);
    expect(messages[0].direction).toBe('outbound');
    expect(messages[0].status).toBe('queued');
    expect(messages[0].messaging_message_id).toBe(messagingMsgId);

    // Verify last_message_at updated
    const updated = await db('conversations').where('id', conversation.id).first();
    expect(updated.last_message_at).not.toBeNull();

    expect(messagingScope.isDone()).toBe(true);
  });

  // ─── POST disables agent mode ──────────────────────────────────────

  it('POST /conversations/:id/messages disables agent mode when agent_mode_active=true', async () => {
    const conversation = await insertConversation({ agent_mode_active: true, agent_exchange_count: 2 });
    const messagingMsgId = '00000000-0000-0000-0000-000000000def';

    nock('http://localhost:3001')
      .post('/messages/send')
      .reply(200, { message_id: messagingMsgId });

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${conversation.id}/messages`,
      headers: AUTH_HEADERS,
      payload: { body: 'Manual reply while agent was active' },
    });

    expect(res.statusCode).toBe(200);

    // Verify agent_mode_active is now false
    const updated = await db('conversations').where('id', conversation.id).first();
    expect(updated.agent_mode_active).toBe(false);
  });
});
