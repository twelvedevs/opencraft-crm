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

describe.skipIf(!HAS_DB)('read tracking (integration)', () => {
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

  const AUTH_HEADERS = {
    'x-internal-api-key': 'test-key',
    'x-user-id': USER_ID,
    'x-user-role': 'call_center_agent',
    'x-user-locations': LOCATION_ID,
  };

  async function insertConversation() {
    const [row] = await db('conversations')
      .insert({
        lead_id: LEAD_ID,
        location_id: LOCATION_ID,
        practice_number: PRACTICE_NUMBER,
        lead_phone: LEAD_PHONE,
        status: 'open',
        last_message_at: new Date(),
      })
      .returning('*');
    return row;
  }

  // ─── POST /conversations/:id/read upserts read record ─────────────

  it('POST /conversations/:id/read upserts read record with latest message id', async () => {
    const conversation = await insertConversation();

    // Insert 3 messages with slight time delays
    const msgIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const [msg] = await db('conversation_messages')
        .insert({
          conversation_id: conversation.id,
          direction: 'inbound',
          status: 'received',
          body: `Message ${i + 1}`,
        })
        .returning('*');
      msgIds.push(msg.id);
    }

    // Mark as read
    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${conversation.id}/read`,
      headers: AUTH_HEADERS,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // Verify conversation_reads row
    const reads = await db('conversation_reads')
      .where({ conversation_id: conversation.id, user_id: USER_ID })
      .select('*');
    expect(reads).toHaveLength(1);
    // last_read_message_id should be the most recent (last inserted) message
    expect(reads[0].last_read_message_id).toBe(msgIds[2]);
  });

  // ─── GET /conversations returns unread_count=0 after read ──────────

  it('GET /conversations returns unread_count=0 after read', async () => {
    const conversation = await insertConversation();

    // Insert 3 messages
    for (let i = 0; i < 3; i++) {
      await db('conversation_messages').insert({
        conversation_id: conversation.id,
        direction: 'inbound',
        status: 'received',
        body: `Message ${i + 1}`,
      });
    }

    // Mark as read
    await app.inject({
      method: 'POST',
      url: `/conversations/${conversation.id}/read`,
      headers: AUTH_HEADERS,
    });

    // List conversations — unread_count should be 0
    const listRes = await app.inject({
      method: 'GET',
      url: `/conversations?location_id=${LOCATION_ID}`,
      headers: AUTH_HEADERS,
    });

    expect(listRes.statusCode).toBe(200);
    const { data } = listRes.json();
    expect(data).toHaveLength(1);
    expect(data[0].unread_count).toBe(0);
  });
});
