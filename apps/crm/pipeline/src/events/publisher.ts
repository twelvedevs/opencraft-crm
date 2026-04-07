import { randomUUID } from 'node:crypto';
import type { EventBus } from '@ortho/event-bus';

export function computeTimeInStage(enteredAt: Date, transitionedAt: Date): number {
  return Math.floor((transitionedAt.getTime() - enteredAt.getTime()) / 1000);
}

export function computeResponseTime(membershipCreatedAt: Date, transitionedAt: Date): number {
  return Math.floor((transitionedAt.getTime() - membershipCreatedAt.getTime()) / 1000);
}

export async function publishStageChanged(
  eventBus: EventBus,
  correlationId: string,
  payload: {
    membership_id: string;
    lead_id: string;
    location_id: string;
    pipeline: string;
    stage_from: string | null;
    stage_to: string;
    override: boolean;
    triggered_by: string | null;
    reason: string;
    timeout_at: string | null;
    transitioned_at: string;
    time_in_stage_seconds: number | null;
    response_time_seconds: number | null;
  },
): Promise<void> {
  await eventBus.publish({
    event_id: randomUUID(),
    event_type: 'lead.stage_changed',
    entity_type: 'lead',
    entity_id: payload.lead_id,
    schema_version: '1.0',
    correlation_id: correlationId,
    payload: payload as unknown as Record<string, unknown>,
  });
}

export async function publishConverted(
  eventBus: EventBus,
  correlationId: string,
  payload: {
    lead_id: string;
    location_id: string;
    from_pipeline: string;
    from_stage: string;
    to_pipeline: string;
    to_stage: string;
    new_membership_id: string;
    channel: string;
    triggered_by: string | null;
    converted_at: string;
  },
): Promise<void> {
  await eventBus.publish({
    event_id: randomUUID(),
    event_type: 'lead.converted',
    entity_type: 'lead',
    entity_id: payload.lead_id,
    schema_version: '1.0',
    correlation_id: correlationId,
    payload: payload as unknown as Record<string, unknown>,
  });
}

export async function publishStageTimeout(
  eventBus: EventBus,
  correlationId: string,
  payload: {
    membership_id: string;
    lead_id: string;
    location_id: string;
    pipeline: string;
    timed_out_stage: string;
    new_stage: string;
    timed_out_at: string;
    exceeded_by_seconds: number;
  },
): Promise<void> {
  await eventBus.publish({
    event_id: randomUUID(),
    event_type: 'lead.stage_timeout',
    entity_type: 'lead',
    entity_id: payload.lead_id,
    schema_version: '1.0',
    correlation_id: correlationId,
    payload: payload as unknown as Record<string, unknown>,
  });
}

export async function publishArchived(
  eventBus: EventBus,
  correlationId: string,
  payload: {
    membership_id: string;
    lead_id: string;
    location_id: string;
    pipeline: string;
    archived_at: string;
  },
): Promise<void> {
  await eventBus.publish({
    event_id: randomUUID(),
    event_type: 'lead.archived',
    entity_type: 'lead',
    entity_id: payload.lead_id,
    schema_version: '1.0',
    correlation_id: correlationId,
    payload: payload as unknown as Record<string, unknown>,
  });
}
