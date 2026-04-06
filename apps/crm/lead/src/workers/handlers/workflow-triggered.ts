import type { Knex } from 'knex';
import type { OrthoEvent } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import * as leadRepository from '../../repositories/lead-repository.js';
import * as activityRepository from '../../repositories/activity-repository.js';

const log = createLogger('crm-lead');

export async function handleWorkflowTriggered(
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
    log.warn({ lead_id }, 'workflow.triggered: lead not found, skipping');
    return;
  }

  await db.transaction(async (trx) => {
    await activityRepository.insertActivity(trx, {
      lead_id,
      event_type: 'workflow.triggered',
      actor_type: 'automation',
      actor_id: null,
      payload: event.payload as Record<string, unknown>,
      occurred_at: new Date().toISOString(),
      source_event_id: event.event_id ?? `fallback:workflow.triggered:${lead_id}:${String(payload.workflow_id)}`,
    });
  });
}
