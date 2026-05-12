import type { EventBus } from '@ortho/event-bus';

export interface CampaignSentPayload {
  campaign_id: string;
  location_id: string;
  sent_count: number;
  template_id: string;
  completed_at: string;
}

export async function publishCampaignSent(
  bus: EventBus,
  payload: CampaignSentPayload,
): Promise<void> {
  await bus.publish({
    event_type: 'campaign.sent',
    entity_type: 'campaign',
    entity_id: payload.campaign_id,
    payload: payload as unknown as Record<string, unknown>,
  });
}
