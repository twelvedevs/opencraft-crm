import type { Knex } from 'knex';
import type { OrthoEvent } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import * as leadRepository from '../../repositories/lead-repository.js';
import * as activityRepository from '../../repositories/activity-repository.js';

const log = createLogger('crm-lead');

export async function handleLeadConverted(
  event: OrthoEvent,
  db: Knex,
): Promise<void> {
  const payload = event.payload;

  const lead_id = String(payload.lead_id);
  const occurred_at = payload.converted_at
    ? new Date(String(payload.converted_at))
    : new Date();

  const lead = await leadRepository.findById(db, lead_id);
  if (!lead) {
    log.warn({ lead_id }, 'lead.converted: lead not found, skipping');
    return;
  }

  await db.transaction(async (trx) => {
    // 1. Insert activity FIRST — timeline entry written before state update
    await activityRepository.insertActivity(trx, {
      lead_id,
      event_type: 'lead.converted',
      actor_type: 'system',
      actor_id: null,
      payload: event.payload as Record<string, unknown>,
      occurred_at: occurred_at.toISOString(),
      source_event_id: event.event_id ?? `fallback:lead.converted:${lead_id}`,
    });

    // 2. Clear pipeline cache — transient state; Pipeline Engine will follow with lead.stage_changed
    await trx.raw(
      `UPDATE crm_leads.leads SET current_pipeline = 'none', current_stage = NULL, updated_at = now() WHERE id = ?`,
      [lead_id],
    );
  });
}
