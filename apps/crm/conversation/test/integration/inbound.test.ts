import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import type { Knex } from 'knex';
import type { EventBus, OrthoEvent } from '@ortho/event-bus';
import { MockDriver, EventBusImpl } from '@ortho/event-bus';
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
  MOCK_LEAD,
  type MockQueue,
} from './helpers.js';

describe.skipIf(!HAS_DB)('inbound message flows (integration)', () => {
  let db: Knex;
  let bus: EventBus;
  let driver: MockDriver;
  let aiAgentQueue: MockQueue;
  let handleInboundMessage: (
    db: Knex,
    bus: EventBus,
    queues: { aiAgentQueue: unknown },
    event: OrthoEvent,
  ) => Promise<void>;

  function makeInboundEvent(overrides: Partial<{
    from_number: string;
    to_number: string;
    body: string;
    message_type: string;
    message_id: string;
    received_at: string;
  }> = {}): OrthoEvent {
    return {
      event_id: 'evt-trigger-001',
      event_type: 'inbound_message.received',
      entity_type: 'message',
      entity_id: 'msg-001',
      schema_version: '1.0',
      correlation_id: 'corr-001',
      payload: {
        from_number: LEAD_PHONE,
        to_number: PRACTICE_NUMBER,
        body: 'Hello, I need info about braces',
        message_type: 'normal',
        message_id: '00000000-0000-0000-0000-000000000abc',
        received_at: new Date().toISOString(),
        ...overrides,
      },
    };
  }

  beforeAll(async () => {
    await runMigrations();
    db = getDb();

    const mod = await import('../../src/events/handlers/inbound-message.handler.js');
    handleInboundMessage = mod.handleInboundMessage;
  });

  afterAll(async () => {
    nock.cleanAll();
    nock.restore();
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
    driver = new MockDriver();
    bus = new EventBusImpl(driver);
    aiAgentQueue = createMockQueue();
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  function mockLeadLookup(lead = MOCK_LEAD) {
    return nock('http://localhost:3000')
      .get('/leads')
      .query({ phone: LEAD_PHONE })
      .reply(200, lead);
  }

  function mockLeadLookup404() {
    return nock('http://localhost:3000')
      .get('/leads')
      .query({ phone: LEAD_PHONE })
      .reply(404, { error: 'not found' });
  }

  function mockNotification() {
    return nock('http://localhost:3004')
      .post('/notifications/publish')
      .reply(200, { ok: true });
  }

  // ─── Happy path ────────────────────────────────────────────

  it('Inbound happy path: creates conversation, stores message, publishes event, sends notification', async () => {
    const leadScope = mockLeadLookup();
    const notifScope = mockNotification();

    const event = makeInboundEvent();
    await handleInboundMessage(db, bus, { aiAgentQueue: aiAgentQueue as unknown }, event);

    // Conversation created
    const conversations = await db('conversations').select('*');
    expect(conversations).toHaveLength(1);
    expect(conversations[0].lead_id).toBe(LEAD_ID);
    expect(conversations[0].location_id).toBe(LOCATION_ID);
    expect(conversations[0].practice_number).toBe(PRACTICE_NUMBER);

    // Message inserted
    const messages = await db('conversation_messages').select('*');
    expect(messages).toHaveLength(1);
    expect(messages[0].direction).toBe('inbound');
    expect(messages[0].status).toBe('received');
    expect(messages[0].conversation_id).toBe(conversations[0].id);

    // Event published (message.received)
    const published = driver.published;
    expect(published).toHaveLength(1);
    expect(published[0].event_type).toBe('message.received');
    expect(published[0].entity_type).toBe('lead');
    expect(published[0].entity_id).toBe(LEAD_ID);

    // Notification POST intercepted
    expect(leadScope.isDone()).toBe(true);
    expect(notifScope.isDone()).toBe(true);
  });

  // ─── Append to existing conversation ───────────────────────

  it('Inbound appends to existing conversation within inactivity window', async () => {
    // Pre-insert conversation with recent last_message_at
    const [existing] = await db('conversations')
      .insert({
        lead_id: LEAD_ID,
        location_id: LOCATION_ID,
        practice_number: PRACTICE_NUMBER,
        lead_phone: LEAD_PHONE,
        status: 'open',
        last_message_at: new Date(),
      })
      .returning('*');

    const leadScope = mockLeadLookup();
    const notifScope = mockNotification();

    await handleInboundMessage(db, bus, { aiAgentQueue: aiAgentQueue as unknown }, makeInboundEvent());

    // Same conversation reused — no new conversation created
    const conversations = await db('conversations').select('*');
    expect(conversations).toHaveLength(1);
    expect(conversations[0].id).toBe(existing.id);

    // Message inserted in existing conversation
    const messages = await db('conversation_messages').select('*');
    expect(messages).toHaveLength(1);
    expect(messages[0].conversation_id).toBe(existing.id);

    expect(leadScope.isDone()).toBe(true);
    expect(notifScope.isDone()).toBe(true);
  });

  // ─── New conversation after inactivity ─────────────────────

  it('Inbound creates new conversation after inactivity window expires', async () => {
    // Pre-insert conversation with last_message_at 31 days ago (default inactivity = 30)
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const [oldConv] = await db('conversations')
      .insert({
        lead_id: LEAD_ID,
        location_id: LOCATION_ID,
        practice_number: PRACTICE_NUMBER,
        lead_phone: LEAD_PHONE,
        status: 'open',
        last_message_at: oldDate,
      })
      .returning('*');

    const leadScope = mockLeadLookup();
    const notifScope = mockNotification();

    await handleInboundMessage(db, bus, { aiAgentQueue: aiAgentQueue as unknown }, makeInboundEvent());

    // New conversation created
    const conversations = await db('conversations').select('*').orderBy('created_at', 'asc');
    expect(conversations).toHaveLength(2);
    expect(conversations[0].id).toBe(oldConv.id);
    expect(conversations[1].id).not.toBe(oldConv.id);

    // Message is in the new conversation
    const messages = await db('conversation_messages').select('*');
    expect(messages).toHaveLength(1);
    expect(messages[0].conversation_id).toBe(conversations[1].id);

    expect(leadScope.isDone()).toBe(true);
    expect(notifScope.isDone()).toBe(true);
  });

  // ─── Unknown phone ─────────────────────────────────────────

  it('Inbound unknown phone: no conversation, no message, no event, warning logged', async () => {
    const leadScope = mockLeadLookup404();

    await handleInboundMessage(db, bus, { aiAgentQueue: aiAgentQueue as unknown }, makeInboundEvent());

    // No conversation created
    const conversations = await db('conversations').select('*');
    expect(conversations).toHaveLength(0);

    // No message inserted
    const messages = await db('conversation_messages').select('*');
    expect(messages).toHaveLength(0);

    // No event published
    expect(driver.published).toHaveLength(0);

    expect(leadScope.isDone()).toBe(true);
  });

  // ─── STOP message ──────────────────────────────────────────

  it('Inbound STOP message: stores message, publishes event, does NOT enqueue AI job', async () => {
    // Enable agent mode for the location
    await db('location_conversation_settings').insert({
      location_id: LOCATION_ID,
      agent_mode_enabled: true,
      location_phone: '+15550001111',
      practice_number: PRACTICE_NUMBER,
    });

    // Pre-create conversation with agent_mode_active
    await db('conversations').insert({
      lead_id: LEAD_ID,
      location_id: LOCATION_ID,
      practice_number: PRACTICE_NUMBER,
      lead_phone: LEAD_PHONE,
      status: 'open',
      agent_mode_active: true,
      last_message_at: new Date(),
    });

    const leadScope = mockLeadLookup();
    const notifScope = mockNotification();

    const event = makeInboundEvent({ message_type: 'stop' });
    await handleInboundMessage(db, bus, { aiAgentQueue: aiAgentQueue as unknown }, event);

    // Message stored with message_type=stop
    const messages = await db('conversation_messages').select('*');
    expect(messages).toHaveLength(1);
    expect(messages[0].message_type).toBe('stop');

    // Event still published
    expect(driver.published).toHaveLength(1);
    expect(driver.published[0].event_type).toBe('message.received');

    // NO BullMQ job enqueued
    expect(aiAgentQueue.jobs).toHaveLength(0);

    expect(leadScope.isDone()).toBe(true);
    expect(notifScope.isDone()).toBe(true);
  });

  // ─── AI agent enqueue ──────────────────────────────────────

  it('Inbound AI agent enqueue: queues job when agent_mode conditions met', async () => {
    // Enable agent mode for the location
    await db('location_conversation_settings').insert({
      location_id: LOCATION_ID,
      agent_mode_enabled: true,
      location_phone: '+15550001111',
      practice_number: PRACTICE_NUMBER,
    });

    // Pre-create conversation with agent_mode_active, unassigned, not escalated
    await db('conversations').insert({
      lead_id: LEAD_ID,
      location_id: LOCATION_ID,
      practice_number: PRACTICE_NUMBER,
      lead_phone: LEAD_PHONE,
      status: 'open',
      agent_mode_active: true,
      assigned_to: null,
      escalated: false,
      agent_exchange_count: 0,
      last_message_at: new Date(),
    });

    const leadScope = mockLeadLookup();
    const notifScope = mockNotification();

    await handleInboundMessage(db, bus, { aiAgentQueue: aiAgentQueue as unknown }, makeInboundEvent());

    // BullMQ job enqueued on ai-agent-reply queue
    expect(aiAgentQueue.jobs).toHaveLength(1);
    expect(aiAgentQueue.jobs[0].name).toBe('ai-agent-reply');
    expect(aiAgentQueue.jobs[0].data).toHaveProperty('conversation_id');
    expect(aiAgentQueue.jobs[0].data).toHaveProperty('trigger_message_id');

    expect(leadScope.isDone()).toBe(true);
    expect(notifScope.isDone()).toBe(true);
  });

  // ─── Escalation on max exchanges ──────────────────────────

  it('Inbound escalation on max exchanges: escalates, sends notification, no BullMQ job', async () => {
    // Enable agent mode with max_exchanges = 3
    await db('location_conversation_settings').insert({
      location_id: LOCATION_ID,
      agent_mode_enabled: true,
      agent_max_exchanges: 3,
      location_phone: '+15550001111',
      practice_number: PRACTICE_NUMBER,
    });

    // Pre-create conversation at max exchanges
    await db('conversations').insert({
      lead_id: LEAD_ID,
      location_id: LOCATION_ID,
      practice_number: PRACTICE_NUMBER,
      lead_phone: LEAD_PHONE,
      status: 'open',
      agent_mode_active: true,
      assigned_to: null,
      escalated: false,
      agent_exchange_count: 3, // >= agent_max_exchanges
      last_message_at: new Date(),
    });

    const leadScope = mockLeadLookup();
    // Two notification calls: one for inbound message, one for escalation
    const notifScope = nock('http://localhost:3004')
      .post('/notifications/publish')
      .reply(200, { ok: true })
      .post('/notifications/publish')
      .reply(200, { ok: true });

    await handleInboundMessage(db, bus, { aiAgentQueue: aiAgentQueue as unknown }, makeInboundEvent());

    // Conversation escalated
    const conversations = await db('conversations').select('*');
    expect(conversations).toHaveLength(1);
    expect(conversations[0].escalated).toBe(true);

    // Escalation notification sent (second notification call)
    expect(notifScope.isDone()).toBe(true);

    // NO BullMQ job enqueued
    expect(aiAgentQueue.jobs).toHaveLength(0);

    expect(leadScope.isDone()).toBe(true);
  });
});
