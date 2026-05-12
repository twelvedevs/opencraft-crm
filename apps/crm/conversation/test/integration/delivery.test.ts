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
} from './helpers.js';

describe.skipIf(!HAS_DB)('delivery status updates (integration)', () => {
  let db: Knex;
  let handleMessageDelivered: (db: Knex, event: import('@ortho/event-bus').OrthoEvent) => Promise<void>;

  beforeAll(async () => {
    await runMigrations();
    db = getDb();

    const mod = await import('../../src/events/handlers/message-delivered.handler.js');
    handleMessageDelivered = mod.handleMessageDelivered;
  });

  afterAll(async () => {
    nock.cleanAll();
    nock.restore();
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

  // ─── message.delivered updates status ──────────────────────────────

  it('message.delivered event updates status to delivered and sets delivered_at', async () => {
    const conversation = await insertConversation();
    const messagingMessageId = '00000000-0000-0000-0000-0000000de11v';

    // Pre-insert outbound message
    await db('conversation_messages').insert({
      conversation_id: conversation.id,
      direction: 'outbound',
      status: 'queued',
      messaging_message_id: messagingMessageId,
    });

    const deliveredAt = new Date().toISOString();
    await handleMessageDelivered(db, {
      event_id: 'evt-del-001',
      event_type: 'message.delivered',
      entity_type: 'message',
      entity_id: messagingMessageId,
      schema_version: '1.0',
      correlation_id: 'corr-del-001',
      payload: {
        message_id: messagingMessageId,
        delivered_at: deliveredAt,
      },
    });

    const messages = await db('conversation_messages')
      .where('messaging_message_id', messagingMessageId)
      .select('*');
    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe('delivered');
    expect(messages[0].delivered_at).not.toBeNull();
  });

  // ─── Unknown messaging_message_id is silent no-op ──────────────────

  it('message.delivered for unknown messaging_message_id is silent no-op', async () => {
    const unknownId = '00000000-0000-0000-0000-ffffffffffff';

    // Should not throw
    await handleMessageDelivered(db, {
      event_id: 'evt-del-002',
      event_type: 'message.delivered',
      entity_type: 'message',
      entity_id: unknownId,
      schema_version: '1.0',
      correlation_id: 'corr-del-002',
      payload: {
        message_id: unknownId,
        delivered_at: new Date().toISOString(),
      },
    });

    // No rows changed
    const allMessages = await db('conversation_messages').select('*');
    expect(allMessages).toHaveLength(0);
  });
});
