import { type Static, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const InboundEventSchema = Type.Object({
  event_id: Type.String(),
  event_type: Type.String(),
  entity_type: Type.Optional(Type.String()),
  entity_id: Type.Optional(Type.String()),
  payload: Type.Record(Type.String(), Type.Unknown()),
});

export type InboundEvent = Static<typeof InboundEventSchema>;

export class ParseError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

export function parseEventBridgeMessage(sqsBody: string): InboundEvent {
  let envelope: unknown;
  try {
    envelope = JSON.parse(sqsBody);
  } catch (err) {
    throw new ParseError('Invalid JSON in SQS message body', err);
  }

  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    !('detail' in envelope)
  ) {
    throw new ParseError('Missing "detail" field in EventBridge envelope');
  }

  const detail = (envelope as Record<string, unknown>)['detail'];

  if (!Value.Check(InboundEventSchema, detail)) {
    const errors = [...Value.Errors(InboundEventSchema, detail)];
    const summary = errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    throw new ParseError(`Invalid InboundEvent in detail: ${summary}`);
  }

  return detail as InboundEvent;
}
