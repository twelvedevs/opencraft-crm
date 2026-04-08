import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Knex } from 'knex';
import type { OrthoEvent } from '@ortho/event-bus';
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

describe.skipIf(!HAS_DB)('message.failed handler (integration)', () => {
  let db: Knex;
  let handleMessageFailed: (db: Knex, event: OrthoEvent) => Promise<void>;

  beforeAll(async () => {
    await runMigrations();
    db = getDb();

    const mod = await import('../../src/events/handlers/message-failed.handler.js');
    handleMessageFailed = mod.handleMessageFailed;
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
  });

  async function insertConversationWithMessage(messagingMessageId: string) {
    const [conversation] = await db('conversations')
      .insert({
        lead_id: LEAD_ID,
        location_id: LOCATION_ID,
        practice_number: PRACTICE_NUMBER,
        lead_phone: LEAD_PHONE,
        status: 'open',
        last_message_at: new Date(),
      })
      .returning('*');

    const [message] = await db('conversation_messages')
      .insert({
        conversation_id: conversation.id,
        direction: 'outbound',
        status: 'queued',
        messaging_message_id: messagingMessageId,
      })
      .returning('*');

    return { conversation, message };
  }

  function makeFailedEvent(messagingMessageId: string): OrthoEvent {
    return {
      event_id: 'evt-fail-001',
      event_type: 'message.failed',
      entity_type: 'message',
      entity_id: messagingMessageId,
      schema_version: '1.0',
      payload: { message_id: messagingMessageId },
    };
  }

  it('updates message status to failed', async () => {
    const msgId = '00000000-0000-0000-0000-000000000fa1';
    const { message } = await insertConversationWithMessage(msgId);

    await handleMessageFailed(db, makeFailedEvent(msgId));

    const updated = await db('conversation_messages').where('id', message.id).first();
    expect(updated.status).toBe('failed');
  });

  it('silently no-ops for unknown messaging_message_id', async () => {
    const unknownId = '00000000-0000-0000-0000-deadbeefcafe';

    // Should not throw even when no matching row
    await expect(handleMessageFailed(db, makeFailedEvent(unknownId))).resolves.not.toThrow();
  });

  it('only updates the matching message when multiple messages exist', async () => {
    const targetId = '00000000-0000-0000-0000-000000000fa2';
    const otherId = '00000000-0000-0000-0000-000000000fa3';

    const [conversation] = await db('conversations')
      .insert({
        lead_id: LEAD_ID,
        location_id: LOCATION_ID,
        practice_number: PRACTICE_NUMBER,
        lead_phone: LEAD_PHONE,
        status: 'open',
        last_message_at: new Date(),
      })
      .returning('*');

    const [targetMsg] = await db('conversation_messages')
      .insert({
        conversation_id: conversation.id,
        direction: 'outbound',
        status: 'queued',
        messaging_message_id: targetId,
      })
      .returning('*');

    const [otherMsg] = await db('conversation_messages')
      .insert({
        conversation_id: conversation.id,
        direction: 'outbound',
        status: 'queued',
        messaging_message_id: otherId,
      })
      .returning('*');

    await handleMessageFailed(db, makeFailedEvent(targetId));

    const updatedTarget = await db('conversation_messages').where('id', targetMsg.id).first();
    const updatedOther = await db('conversation_messages').where('id', otherMsg.id).first();
    expect(updatedTarget.status).toBe('failed');
    expect(updatedOther.status).toBe('queued');
  });
});
