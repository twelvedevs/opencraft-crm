import type { EventBus } from '@ortho/event-bus';

export async function publishInboundMessageReceived(
  eventBus: EventBus,
  payload: {
    message_id: string;
    from_number: string;
    to_number: string;
    body: string | null;
    media_urls: string[] | null;
    received_at: Date | string;
    message_type: string;
  },
): Promise<void> {
  await eventBus.publish({
    event_type: 'inbound_message.received',
    entity_type: 'message',
    entity_id: payload.message_id,
    payload: payload as unknown as Record<string, unknown>,
  });
}

export async function publishMessageDelivered(
  eventBus: EventBus,
  payload: {
    message_id: string;
    twilio_sid: string | null;
    to_number: string;
    from_number: string;
    location_id: string | null;
    delivered_at: Date | string;
  },
): Promise<void> {
  await eventBus.publish({
    event_type: 'message.delivered',
    entity_type: 'message',
    entity_id: payload.message_id,
    payload: payload as unknown as Record<string, unknown>,
  });
}

export async function publishMessageFailed(
  eventBus: EventBus,
  payload: {
    message_id: string;
    twilio_sid: string | null;
    to_number: string;
    from_number: string;
    location_id: string | null;
    error_code: string | null;
    error_message: string | null;
  },
): Promise<void> {
  await eventBus.publish({
    event_type: 'message.failed',
    entity_type: 'message',
    entity_id: payload.message_id,
    payload: payload as unknown as Record<string, unknown>,
  });
}

export async function publishOptOutReceived(
  eventBus: EventBus,
  payload: {
    phone_number: string;
    opted_out_at: Date | string;
    source: string;
    location_id: string | null;
  },
): Promise<void> {
  await eventBus.publish({
    event_type: 'opt_out.received',
    entity_type: 'opt_out',
    entity_id: payload.phone_number,
    payload: payload as unknown as Record<string, unknown>,
  });
}

export async function publishOptOutRemoved(
  eventBus: EventBus,
  payload: {
    phone_number: string;
    removed_at: Date | string;
  },
): Promise<void> {
  await eventBus.publish({
    event_type: 'opt_out.removed',
    entity_type: 'opt_out',
    entity_id: payload.phone_number,
    payload: payload as unknown as Record<string, unknown>,
  });
}
