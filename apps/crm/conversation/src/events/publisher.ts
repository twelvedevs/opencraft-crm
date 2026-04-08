import { randomUUID } from 'node:crypto';
import type { EventBus } from '@ortho/event-bus';

export interface MessageReceivedPayload {
  entity_type: 'lead';
  entity_id: string;
  message_id: string;
  conversation_id: string;
  lead_id: string;
  location_id: string;
  body: string;
  message_type: 'normal' | 'stop' | 'unstop';
  from_number: string;
  practice_number: string;
  received_at: string;
}

export async function publishMessageReceived(
  bus: EventBus,
  data: {
    correlationId: string;
    causationId: string;
    payload: MessageReceivedPayload;
  },
): Promise<void> {
  await bus.publish({
    event_id: randomUUID(),
    event_type: 'message.received',
    entity_type: 'lead',
    entity_id: data.payload.lead_id,
    schema_version: '1.0',
    correlation_id: data.correlationId,
    causation_id: data.causationId,
    payload: data.payload as unknown as Record<string, unknown>,
  });
}
