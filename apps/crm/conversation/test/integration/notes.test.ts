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

describe.skipIf(!HAS_DB)('notes routes (integration)', () => {
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

  const authHeaders = {
    'x-internal-api-key': 'test-key',
    'x-user-id': USER_ID,
    'x-user-role': 'call_center_agent',
    'x-user-locations': LOCATION_ID,
  };

  // ─── POST /conversations/:id/notes ──────────────────────────────────

  it('creates a note and returns 201', async () => {
    const conversation = await insertConversation();

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${conversation.id}/notes`,
      headers: authHeaders,
      payload: { body: 'Patient called about pricing.' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.body).toBe('Patient called about pricing.');
    expect(body.author_id).toBe(USER_ID);

    const notes = await db('conversation_notes').where('conversation_id', conversation.id);
    expect(notes).toHaveLength(1);
  });

  it('POST note returns 403 when no auth', async () => {
    const conversation = await insertConversation();

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${conversation.id}/notes`,
      headers: { 'x-internal-api-key': 'test-key' },
      payload: { body: 'test' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('POST note returns 403 for different location', async () => {
    const conversation = await insertConversation();

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${conversation.id}/notes`,
      headers: {
        'x-internal-api-key': 'test-key',
        'x-user-id': USER_ID,
        'x-user-role': 'call_center_agent',
        'x-user-locations': '00000000-0000-0000-0000-000000000999',
      },
      payload: { body: 'test' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('POST note returns 404 for unknown conversation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/conversations/00000000-0000-0000-0000-000000000000/notes',
      headers: authHeaders,
      payload: { body: 'test' },
    });

    expect(res.statusCode).toBe(404);
  });

  // ─── DELETE /conversations/:id/notes/:note_id ────────────────────────

  it('deletes a note and returns 200', async () => {
    const conversation = await insertConversation();
    const [note] = await db('conversation_notes')
      .insert({ conversation_id: conversation.id, author_id: USER_ID, body: 'To delete' })
      .returning('*');

    const res = await app.inject({
      method: 'DELETE',
      url: `/conversations/${conversation.id}/notes/${note.id}`,
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    const notes = await db('conversation_notes').where('id', note.id);
    expect(notes).toHaveLength(0);
  });

  it('DELETE note returns 404 when note does not exist', async () => {
    const conversation = await insertConversation();

    const res = await app.inject({
      method: 'DELETE',
      url: `/conversations/${conversation.id}/notes/00000000-0000-0000-0000-000000000000`,
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(404);
  });

  it('DELETE note returns 404 when note belongs to different conversation', async () => {
    const conv1 = await insertConversation();
    const [, conv2Row] = await db('conversations')
      .insert({
        lead_id: LEAD_ID,
        location_id: LOCATION_ID,
        practice_number: '+15550000001',
        lead_phone: LEAD_PHONE,
        status: 'open',
        last_message_at: new Date(),
      })
      .returning('*');

    const [note] = await db('conversation_notes')
      .insert({ conversation_id: conv1.id, author_id: USER_ID, body: 'Not yours' })
      .returning('*');

    const res = await app.inject({
      method: 'DELETE',
      url: `/conversations/${conv2Row.id}/notes/${note.id}`,
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(404);
  });
});
