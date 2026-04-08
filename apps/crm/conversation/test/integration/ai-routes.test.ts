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
  LEAD_ID,
  PRACTICE_NUMBER,
  LEAD_PHONE,
  USER_ID,
  MOCK_LEAD,
} from './helpers.js';

describe.skipIf(!HAS_DB)('AI routes (integration)', () => {
  let db: Knex;
  let app: Awaited<ReturnType<typeof import('../../src/app.js').buildApp>>;
  const AI_SERVICE_URL = 'http://localhost:3002';
  const LEAD_SERVICE_URL = 'http://localhost:3000';

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

  // ─── POST /conversations/:id/ai/drafts ────────────────────────────────

  it('GET /ai/drafts returns 403 when no auth', async () => {
    const conversation = await insertConversation();
    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${conversation.id}/ai/drafts`,
      headers: { 'x-internal-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /ai/drafts returns 404 for unknown conversation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/conversations/00000000-0000-0000-0000-000000000000/ai/drafts',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /ai/drafts returns drafts from AI service', async () => {
    const conversation = await insertConversation();
    const drafts = [{ body: 'Thanks for your interest!', label: 'Friendly' }];

    nock(LEAD_SERVICE_URL)
      .get(`/leads/${LEAD_ID}`)
      .reply(200, MOCK_LEAD);

    nock(AI_SERVICE_URL)
      .post('/ai/complete')
      .reply(200, { text: JSON.stringify(drafts) });

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${conversation.id}/ai/drafts`,
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ drafts });
  });

  it('POST /ai/drafts returns 403 for wrong location', async () => {
    const conversation = await insertConversation();
    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${conversation.id}/ai/drafts`,
      headers: {
        'x-internal-api-key': 'test-key',
        'x-user-id': USER_ID,
        'x-user-role': 'call_center_agent',
        'x-user-locations': '00000000-0000-0000-0000-000000000999',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── POST /conversations/:id/ai/summary ──────────────────────────────

  it('POST /ai/summary returns 403 when no auth', async () => {
    const conversation = await insertConversation();
    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${conversation.id}/ai/summary`,
      headers: { 'x-internal-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /ai/summary returns summary from AI service', async () => {
    const conversation = await insertConversation();

    nock(AI_SERVICE_URL)
      .post('/ai/complete')
      .reply(200, { text: 'Patient is considering Invisalign for cosmetic reasons.' });

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${conversation.id}/ai/summary`,
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().summary).toBe('Patient is considering Invisalign for cosmetic reasons.');
  });

  // ─── POST /conversations/:id/ai/objection ────────────────────────────

  it('POST /ai/objection returns 403 when no auth', async () => {
    const conversation = await insertConversation();
    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${conversation.id}/ai/objection`,
      headers: { 'x-internal-api-key': 'test-key' },
      payload: { objection_type: 'cost' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /ai/objection returns strategies from AI service', async () => {
    const conversation = await insertConversation();
    const strategies = [{ title: 'Financing', body: 'We offer 0% financing.' }];

    nock(AI_SERVICE_URL)
      .post('/ai/complete')
      .reply(200, { text: JSON.stringify(strategies) });

    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${conversation.id}/ai/objection`,
      headers: authHeaders,
      payload: { objection_type: 'cost' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ strategies });
  });
});
