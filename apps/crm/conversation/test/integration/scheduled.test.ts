import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import type { Knex } from 'knex';
import {
  HAS_DB,
  getDb,
  runMigrations,
  cleanup,
  truncateTables,
  createMockQueue,
  LOCATION_ID,
  LEAD_ID,
  PRACTICE_NUMBER,
  LEAD_PHONE,
  USER_ID,
  type MockQueue,
} from './helpers.js';

describe.skipIf(!HAS_DB)('scheduled send lifecycle (integration)', () => {
  let db: Knex;
  let scheduledSendQueue: MockQueue;
  let app: Awaited<ReturnType<typeof import('../../src/app.js').buildApp>>;

  let scheduledRepo: typeof import('../../src/repositories/scheduled.repo.js');
  let conversationsRepo: typeof import('../../src/repositories/conversations.repo.js');
  let messagesRepo: typeof import('../../src/repositories/messages.repo.js');

  beforeAll(async () => {
    await runMigrations();
    db = getDb();

    scheduledRepo = await import('../../src/repositories/scheduled.repo.js');
    conversationsRepo = await import('../../src/repositories/conversations.repo.js');
    messagesRepo = await import('../../src/repositories/messages.repo.js');

    const { EventBusImpl, MockDriver } = await import('@ortho/event-bus');
    const driver = new MockDriver();
    const bus = new EventBusImpl(driver);

    scheduledSendQueue = createMockQueue();

    const { buildApp } = await import('../../src/app.js');
    app = await buildApp(db, bus, { scheduledSendQueue: scheduledSendQueue as unknown as import('bullmq').Queue });
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
    scheduledSendQueue.jobs.length = 0;
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

  /**
   * Simulate the scheduled-send worker handler directly
   * (mirrors src/workers/scheduled-send.worker.ts processor).
   */
  async function runScheduledSendWorkerHandler(scheduledMessageId: string) {
    const { messagingClient } = await import('../../src/lib/service-client.js');

    const scheduled = await scheduledRepo.findById(db, scheduledMessageId);
    if (!scheduled) return;
    if (scheduled.status !== 'pending') return;

    const conversation = await conversationsRepo.findById(db, scheduled.conversation_id);
    if (!conversation) return;

    const response = await messagingClient.post<{ message_id: string }>('/messages/send', {
      to: conversation.lead_phone,
      from_number: conversation.practice_number,
      body: scheduled.body,
      dedup_key: `sched:${scheduledMessageId}`,
    });

    await messagesRepo.insert(db, {
      conversation_id: conversation.id,
      direction: 'outbound',
      author_id: scheduled.created_by,
      body: scheduled.body,
      status: 'queued',
      messaging_message_id: response.message_id,
    });

    await scheduledRepo.updateStatus(db, scheduledMessageId, 'sent', new Date());

    await conversationsRepo.update(db, conversation.id, {
      last_message_at: new Date(),
    });
  }

  // ─── Create + fire scheduled send ──────────────────────────────────

  it('create + fire scheduled send: POST creates record, worker sends and marks sent', async () => {
    const conversation = await insertConversation();
    const scheduledFor = new Date(Date.now() + 60000).toISOString(); // 1 minute from now

    // Create scheduled message via API
    const res = await app.inject({
      method: 'POST',
      url: `/conversations/${conversation.id}/scheduled-messages`,
      headers: AUTH_HEADERS,
      payload: {
        body: 'Scheduled reminder text',
        scheduled_for: scheduledFor,
      },
    });

    expect(res.statusCode).toBe(201);
    const { scheduled_message_id } = res.json();
    expect(scheduled_message_id).toBeDefined();

    // Verify BullMQ job was enqueued
    expect(scheduledSendQueue.jobs).toHaveLength(1);

    // Now simulate worker firing
    const messagingMsgId = '00000000-0000-0000-0000-000000000sch';
    const messagingScope = nock('http://localhost:3001')
      .post('/messages/send')
      .reply(200, { message_id: messagingMsgId });

    await runScheduledSendWorkerHandler(scheduled_message_id);

    // Verify scheduled message marked as sent
    const scheduled = await db('scheduled_messages').where('id', scheduled_message_id).first();
    expect(scheduled.status).toBe('sent');
    expect(scheduled.sent_at).not.toBeNull();

    // Verify conversation message inserted
    const messages = await db('conversation_messages')
      .where('conversation_id', conversation.id)
      .select('*');
    expect(messages).toHaveLength(1);
    expect(messages[0].direction).toBe('outbound');
    expect(messages[0].body).toBe('Scheduled reminder text');

    expect(messagingScope.isDone()).toBe(true);
  });

  // ─── Cancel before fire ────────────────────────────────────────────

  it('cancel before fire: cancelled scheduled message is skipped by worker', async () => {
    const conversation = await insertConversation();
    const scheduledFor = new Date(Date.now() + 60000).toISOString();

    // Create scheduled message
    const createRes = await app.inject({
      method: 'POST',
      url: `/conversations/${conversation.id}/scheduled-messages`,
      headers: AUTH_HEADERS,
      payload: {
        body: 'Will be cancelled',
        scheduled_for: scheduledFor,
      },
    });

    expect(createRes.statusCode).toBe(201);
    const { scheduled_message_id } = createRes.json();

    // Cancel it
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/conversations/${conversation.id}/scheduled-messages/${scheduled_message_id}`,
      headers: AUTH_HEADERS,
    });

    expect(deleteRes.statusCode).toBe(200);

    // Verify status is cancelled
    const cancelled = await db('scheduled_messages').where('id', scheduled_message_id).first();
    expect(cancelled.status).toBe('cancelled');

    // Worker should skip (idempotency guard: status !== 'pending')
    await runScheduledSendWorkerHandler(scheduled_message_id);

    // Messaging Service NOT called — no messages in DB
    const messages = await db('conversation_messages')
      .where('conversation_id', conversation.id)
      .select('*');
    expect(messages).toHaveLength(0);
  });
});
