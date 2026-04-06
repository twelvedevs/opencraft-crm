import type { Knex } from 'knex';
import type { OrthoEvent } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import * as leadRepository from '../../repositories/lead-repository.js';
import * as activityRepository from '../../repositories/activity-repository.js';

const log = createLogger('crm-lead');

export async function handleReferralConverted(
  event: OrthoEvent,
  db: Knex,
): Promise<void> {
  const payload = event.payload;

  const lead_id = String(payload.lead_id);

  const lead = await leadRepository.findById(db, lead_id);
  if (!lead) {
    log.warn({ lead_id }, 'referral.converted: lead not found, skipping');
    return;
  }

  await db.transaction(async (trx) => {
    await activityRepository.insertActivity(trx, {
      lead_id,
      event_type: 'referral.converted',
      actor_type: 'system',
      actor_id: null,
      payload: event.payload as Record<string, unknown>,
      occurred_at: new Date().toISOString(),
      source_event_id: event.event_id ?? `fallback:referral.converted:${lead_id}`,
    });
  });
}
