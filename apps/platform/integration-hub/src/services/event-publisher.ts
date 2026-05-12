import type { EventBus } from '@ortho/event-bus';
import type { AdLeadReceivedPayload, AdSpendSyncedPayload } from '@ortho/types';

export async function publishAdLeadReceived(
  bus: EventBus,
  payload: AdLeadReceivedPayload,
): Promise<void> {
  await bus.publish({
    event_type: 'ad_lead.received',
    entity_type: 'ad_lead',
    entity_id: payload.external_lead_id,
    payload: payload as unknown as Record<string, unknown>,
  });
}

export async function publishAdSpendSynced(
  bus: EventBus,
  payload: AdSpendSyncedPayload,
): Promise<void> {
  await bus.publish({
    event_type: 'ad_spend.synced',
    entity_type: 'ad_spend',
    entity_id: `${payload.platform}:${payload.location_id}:${payload.synced_date}`,
    payload: payload as unknown as Record<string, unknown>,
  });
}
