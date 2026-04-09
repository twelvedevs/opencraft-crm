import type { EventBus } from '@ortho/event-bus';
import type { ReferralConvertedPayload, ReferrerCreatedPayload } from '@ortho/types';

export async function publishReferralConverted(
  bus: EventBus,
  payload: ReferralConvertedPayload,
): Promise<void> {
  await bus.publish({
    event_type: 'referral.converted',
    entity_type: 'referral',
    entity_id: payload.referral_id,
    payload: payload as unknown as Record<string, unknown>,
  });
}

export async function publishReferrerCreated(
  bus: EventBus,
  payload: ReferrerCreatedPayload,
): Promise<void> {
  await bus.publish({
    event_type: 'referrer.created',
    entity_type: 'referrer',
    entity_id: payload.referrer_id,
    payload: payload as unknown as Record<string, unknown>,
  });
}
