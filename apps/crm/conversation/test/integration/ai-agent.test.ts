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
  MOCK_LEAD,
} from './helpers.js';

describe.skipIf(!HAS_DB)('AI agent reply worker (integration)', () => {
  let db: Knex;

  // We call the worker's inner handler logic directly by importing the repos + services
  // and replicating the worker flow (since the real worker requires BullMQ Redis).
  // Instead, import the source modules and invoke the logic.
  let conversationsRepo: typeof import('../../src/repositories/conversations.repo.js');
  let messagesRepo: typeof import('../../src/repositories/messages.repo.js');
  let settingsRepo: typeof import('../../src/repositories/settings.repo.js');
  let agentMode: typeof import('../../src/services/agent-mode.js');

  beforeAll(async () => {
    await runMigrations();
    db = getDb();

    conversationsRepo = await import('../../src/repositories/conversations.repo.js');
    messagesRepo = await import('../../src/repositories/messages.repo.js');
    settingsRepo = await import('../../src/repositories/settings.repo.js');
    agentMode = await import('../../src/services/agent-mode.js');
  });

  afterAll(async () => {
    nock.cleanAll();
    nock.restore();
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  async function setupConversation(overrides: Record<string, unknown> = {}) {
    await db('location_conversation_settings').insert({
      location_id: LOCATION_ID,
      agent_mode_enabled: true,
      location_phone: '+15550001111',
      practice_number: PRACTICE_NUMBER,
    });

    const [conversation] = await db('conversations')
      .insert({
        lead_id: LEAD_ID,
        location_id: LOCATION_ID,
        practice_number: PRACTICE_NUMBER,
        lead_phone: LEAD_PHONE,
        status: 'open',
        agent_mode_active: true,
        agent_exchange_count: 0,
        last_message_at: new Date(),
        ...overrides,
      })
      .returning('*');

    // Insert a trigger message
    const [msg] = await db('conversation_messages')
      .insert({
        conversation_id: conversation.id,
        direction: 'inbound',
        status: 'received',
        body: 'I want to know about braces',
      })
      .returning('*');

    return { conversation, triggerMessageId: msg.id };
  }

  function mockLeadLookup() {
    return nock('http://localhost:3000')
      .get(`/leads/${LEAD_ID}`)
      .reply(200, MOCK_LEAD);
  }

  function mockNotification() {
    return nock('http://localhost:3004')
      .post('/notifications/publish')
      .reply(200, { ok: true });
  }

  /**
   * Simulate the ai-agent-reply worker handler logic directly
   * (mirrors src/workers/ai-agent-reply.worker.ts processor).
   */
  async function runAgentWorkerHandler(conversationId: string, triggerMessageId: string) {
    const conversation = await conversationsRepo.findById(db, conversationId);
    if (!conversation) throw new Error('Conversation not found');

    const messages = await messagesRepo.listByConversation(db, conversationId, { limit: 10 });
    const settings = await settingsRepo.getEffectiveSettings(db, conversation.location_id);

    const { leadClient, aiClient, messagingClient, notificationClient } = await import('../../src/lib/service-client.js');

    const lead = await leadClient.get<{
      id: string; name: string; current_stage: string; treatment_interest: string;
    }>(`/leads/${conversation.lead_id}`);

    const response = await aiClient.post<{ text: string }>('/ai/complete', {
      prompt_id: 'conversation-agent-reply',
      context: {
        lead_name: lead.name,
        lead_stage: lead.current_stage,
        treatment_interest: lead.treatment_interest,
        location_name: settings.location_phone,
        recent_messages: messages.map((m) => ({
          direction: m.direction,
          body: m.body,
          created_at: m.created_at,
        })),
      },
    });

    const parsed = agentMode.parseAgentResponse(response.text);

    if (!parsed || parsed.escalate) {
      await conversationsRepo.update(db, conversation.id, {
        escalated: true,
        agent_mode_active: false,
      });

      try {
        await notificationClient.post('/notifications/publish', {
          channel: `location:${conversation.location_id}:conversations`,
          payload: { type: 'agent_escalation', conversation_id: conversation.id },
        });
      } catch {
        // non-critical
      }
      return;
    }

    const fullBody = parsed.text + '\n\n' + agentMode.buildDisclosureFooter(settings.location_phone!);
    const dedupKey = `agent:${conversationId}:${conversation.agent_exchange_count}`;

    const msgResponse = await messagingClient.post<{ message_id: string }>('/messages/send', {
      to: conversation.lead_phone,
      from_number: conversation.practice_number,
      body: fullBody,
      dedup_key: dedupKey,
    });

    await messagesRepo.insert(db, {
      conversation_id: conversation.id,
      direction: 'outbound',
      is_agent: true,
      is_automated: false,
      status: 'queued',
      messaging_message_id: msgResponse.message_id,
      body: fullBody,
    });

    await conversationsRepo.update(db, conversation.id, {
      agent_exchange_count: conversation.agent_exchange_count + 1,
      last_message_at: new Date(),
    });
  }

  // ─── Normal AI agent reply ─────────────────────────────────────────

  it('AI agent reply: sends message, stores with is_agent=true, increments agent_exchange_count', async () => {
    const { conversation, triggerMessageId } = await setupConversation();

    const leadScope = mockLeadLookup();
    const aiScope = nock('http://localhost:3002')
      .post('/ai/complete')
      .reply(200, { text: JSON.stringify({ text: 'Hello! We offer great braces options.', escalate: false }) });
    const messagingMsgId = '00000000-0000-0000-0000-000000000aaa';
    const messagingScope = nock('http://localhost:3001')
      .post('/messages/send')
      .reply(200, { message_id: messagingMsgId });

    await runAgentWorkerHandler(conversation.id, triggerMessageId);

    // Verify message stored with is_agent=true
    const messages = await db('conversation_messages')
      .where('conversation_id', conversation.id)
      .where('direction', 'outbound')
      .select('*');
    expect(messages).toHaveLength(1);
    expect(messages[0].is_agent).toBe(true);
    expect(messages[0].status).toBe('queued');
    expect(messages[0].messaging_message_id).toBe(messagingMsgId);

    // Verify agent_exchange_count incremented
    const updatedConv = await db('conversations').where('id', conversation.id).first();
    expect(updatedConv.agent_exchange_count).toBe(1);

    expect(leadScope.isDone()).toBe(true);
    expect(aiScope.isDone()).toBe(true);
    expect(messagingScope.isDone()).toBe(true);
  });

  // ─── Escalation — escalate:true ────────────────────────────────────

  it('AI agent escalation — escalate:true: sets escalated, disables agent mode, does NOT send message', async () => {
    const { conversation, triggerMessageId } = await setupConversation();

    const leadScope = mockLeadLookup();
    const aiScope = nock('http://localhost:3002')
      .post('/ai/complete')
      .reply(200, { text: JSON.stringify({ text: '', escalate: true, reason: 'complex case' }) });
    const notifScope = mockNotification();

    await runAgentWorkerHandler(conversation.id, triggerMessageId);

    // Verify conversation escalated
    const updatedConv = await db('conversations').where('id', conversation.id).first();
    expect(updatedConv.escalated).toBe(true);
    expect(updatedConv.agent_mode_active).toBe(false);

    // Verify NO outbound message sent (only the inbound trigger exists)
    const outboundMessages = await db('conversation_messages')
      .where('conversation_id', conversation.id)
      .where('direction', 'outbound')
      .select('*');
    expect(outboundMessages).toHaveLength(0);

    expect(leadScope.isDone()).toBe(true);
    expect(aiScope.isDone()).toBe(true);
    expect(notifScope.isDone()).toBe(true);
  });

  // ─── Escalation — parse failure ────────────────────────────────────

  it('AI agent escalation — parse failure: escalates when AI returns non-JSON', async () => {
    const { conversation, triggerMessageId } = await setupConversation();

    const leadScope = mockLeadLookup();
    const aiScope = nock('http://localhost:3002')
      .post('/ai/complete')
      .reply(200, { text: 'not json at all' });
    const notifScope = mockNotification();

    await runAgentWorkerHandler(conversation.id, triggerMessageId);

    // Verify conversation escalated
    const updatedConv = await db('conversations').where('id', conversation.id).first();
    expect(updatedConv.escalated).toBe(true);
    expect(updatedConv.agent_mode_active).toBe(false);

    // Verify Messaging Service NOT called (no outbound message)
    const outboundMessages = await db('conversation_messages')
      .where('conversation_id', conversation.id)
      .where('direction', 'outbound')
      .select('*');
    expect(outboundMessages).toHaveLength(0);

    expect(leadScope.isDone()).toBe(true);
    expect(aiScope.isDone()).toBe(true);
    expect(notifScope.isDone()).toBe(true);
  });
});
