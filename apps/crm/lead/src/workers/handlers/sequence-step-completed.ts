import type { Knex } from 'knex';
import type { OrthoEvent } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import * as leadRepository from '../../repositories/lead-repository.js';
import * as activityRepository from '../../repositories/activity-repository.js';

const log = createLogger('crm-lead');

export async function handleSequenceStepCompleted(
  event: OrthoEvent,
  db: Knex,
): Promise<void> {
  const payload = event.payload;

  const entity_id = String(payload.entity_id);
  const entity_type = String(payload.entity_type);

  if (entity_type !== 'lead') {
    return;
  }

  const lead_id = entity_id;

  const lead = await leadRepository.findById(db, lead_id);
  if (!lead) {
    log.warn({ lead_id }, 'sequence.step_completed: lead not found, skipping');
    return;
  }

  await db.transaction(async (trx) => {
    await activityRepository.insertActivity(trx, {
      lead_id,
      event_type: 'sequence.step_completed',
      actor_type: 'automation',
      actor_id: null,
      payload: event.payload as Record<string, unknown>,
      occurred_at: new Date().toISOString(),
      source_event_id: event.event_id ?? `fallback:sequence.step_completed:${lead_id}:${String(payload.step_id)}`,
    });
  });
}
