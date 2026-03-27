import { describe, expect, it } from 'vitest';
import { ParseError, parseEventBridgeMessage } from '../../src/events/inbound-event.js';

const validDetail = {
  event_id: 'evt-123',
  event_type: 'lead.created',
  entity_type: 'lead',
  entity_id: 'lead-456',
  payload: { source: 'web' },
};

function makeBody(detail: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ detail, ...extra });
}

describe('parseEventBridgeMessage', () => {
  it('(1) valid full event with all fields parses and returns correct InboundEvent', () => {
    const result = parseEventBridgeMessage(makeBody(validDetail));
    expect(result).toEqual(validDetail);
  });

  it('(2) event without entity_type/entity_id parses successfully', () => {
    const detail = {
      event_id: 'evt-789',
      event_type: 'lead.updated',
      payload: { foo: 'bar' },
    };
    const result = parseEventBridgeMessage(makeBody(detail));
    expect(result.event_id).toBe('evt-789');
    expect(result.entity_type).toBeUndefined();
    expect(result.entity_id).toBeUndefined();
  });

  it('(3) malformed JSON body throws ParseError', () => {
    expect(() => parseEventBridgeMessage('not-json')).toThrow(ParseError);
  });

  it('(4) missing "detail" field in envelope throws ParseError', () => {
    expect(() => parseEventBridgeMessage(JSON.stringify({ source: 'aws.events' }))).toThrow(ParseError);
  });

  it('(5) detail.event_id missing throws ParseError', () => {
    const detail = { event_type: 'lead.created', payload: {} };
    expect(() => parseEventBridgeMessage(makeBody(detail))).toThrow(ParseError);
  });

  it('(6) detail.payload missing throws ParseError', () => {
    const detail = { event_id: 'evt-1', event_type: 'lead.created' };
    expect(() => parseEventBridgeMessage(makeBody(detail))).toThrow(ParseError);
  });

  it('(7) unknown event_type string is accepted', () => {
    const detail = { ...validDetail, event_type: 'some.future.event.type.unknown' };
    const result = parseEventBridgeMessage(makeBody(detail));
    expect(result.event_type).toBe('some.future.event.type.unknown');
  });

  it('(8) extra envelope fields (id, source, time) are ignored and parse succeeds', () => {
    const result = parseEventBridgeMessage(
      makeBody(validDetail, { id: 'env-id', source: 'aws.events', time: '2026-03-27T00:00:00Z', region: 'us-east-1' }),
    );
    expect(result).toEqual(validDetail);
  });
});
