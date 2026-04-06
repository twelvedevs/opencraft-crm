import type { EventBus } from '@ortho/event-bus';

export async function publishLeadCreated(
  bus: EventBus,
  payload: {
    lead_id: string;
    location_id: string;
    channel: string;
    current_pipeline: string;
    current_stage: string | null;
    referrer_id?: string;
    referrer_type?: string;
    referral_code?: string;
  },
): Promise<void> {
  await bus.publish({
    event_type: 'lead.created',
    entity_type: 'lead',
    entity_id: payload.lead_id,
    payload,
  });
}

export async function publishLeadUpdated(
  bus: EventBus,
  payload: {
    lead_id: string;
    location_id: string;
    changed_fields: string[];
  },
): Promise<void> {
  await bus.publish({
    event_type: 'lead.updated',
    entity_type: 'lead',
    entity_id: payload.lead_id,
    payload,
  });
}

export async function publishLeadMerged(
  bus: EventBus,
  payload: {
    surviving_lead_id: string;
    merged_lead_id: string;
    location_id: string;
  },
): Promise<void> {
  await bus.publish({
    event_type: 'lead.merged',
    entity_type: 'lead',
    entity_id: payload.surviving_lead_id,
    payload,
  });
}

export async function publishLeadArchived(
  bus: EventBus,
  payload: {
    lead_id: string;
    location_id: string;
  },
): Promise<void> {
  await bus.publish({
    event_type: 'lead.archived',
    entity_type: 'lead',
    entity_id: payload.lead_id,
    payload,
  });
}

export async function publishAppointmentUpdated(
  bus: EventBus,
  payload: {
    lead_id: string;
    appointment_id: string;
    appointment_type: string;
    scheduled_at: string;
    status: string;
    location_id: string;
  },
): Promise<void> {
  await bus.publish({
    event_type: 'appointment.updated',
    entity_type: 'lead',
    entity_id: payload.lead_id,
    payload,
  });
}
