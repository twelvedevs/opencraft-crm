import { describe, it, expect, beforeEach } from 'vitest';
import { MockDriver, EventBusImpl } from '@ortho/event-bus';
import { publishMessageReceived, type MessageReceivedPayload } from '../../src/events/publisher.js';

describe('contract: message.received event', () => {
  let driver: MockDriver;
  let bus: EventBusImpl;

  beforeEach(() => {
    driver = new MockDriver();
    bus = new EventBusImpl(driver);
  });

  const payload: MessageReceivedPayload = {
    entity_type: 'lead',
    entity_id: 'lead-1',
    message_id: 'msg-1',
    conversation_id: 'conv-1',
    lead_id: 'lead-1',
    location_id: 'loc-1',
    body: 'Hi there',
    message_type: 'normal',
    from_number: '+15559876543',
    practice_number: '+15551234567',
    received_at: '2026-04-07T12:00:00.000Z',
  };

  it('publishes event with correct envelope fields', async () => {
    await publishMessageReceived(bus, {
      correlationId: 'corr-1',
      causationId: 'cause-1',
      payload,
    });

    expect(driver.published).toHaveLength(1);
    const event = driver.published[0];

    expect(event.event_id).toEqual(expect.any(String));
    expect(event.event_id.length).toBeGreaterThan(0);
    expect(event.event_type).toBe('message.received');
    expect(event.entity_type).toBe('lead');
    expect(event.entity_id).toBe('lead-1');
    expect(event.schema_version).toBe('1.0');
    expect(event.correlation_id).toBe('corr-1');
    expect(event.causation_id).toBe('cause-1');
  });

  it('publishes event with all required payload fields', async () => {
    await publishMessageReceived(bus, {
      correlationId: 'corr-2',
      causationId: 'cause-2',
      payload,
    });

    const event = driver.published[0];
    const p = event.payload as Record<string, unknown>;

    expect(typeof p.entity_type).toBe('string');
    expect(typeof p.entity_id).toBe('string');
    expect(typeof p.message_id).toBe('string');
    expect(typeof p.conversation_id).toBe('string');
    expect(typeof p.lead_id).toBe('string');
    expect(typeof p.location_id).toBe('string');
    expect(typeof p.body).toBe('string');
    expect(typeof p.message_type).toBe('string');
    expect(typeof p.from_number).toBe('string');
    expect(typeof p.practice_number).toBe('string');
    expect(typeof p.received_at).toBe('string');

    expect(p).toEqual({
      entity_type: 'lead',
      entity_id: 'lead-1',
      message_id: 'msg-1',
      conversation_id: 'conv-1',
      lead_id: 'lead-1',
      location_id: 'loc-1',
      body: 'Hi there',
      message_type: 'normal',
      from_number: '+15559876543',
      practice_number: '+15551234567',
      received_at: '2026-04-07T12:00:00.000Z',
    });
  });
});
