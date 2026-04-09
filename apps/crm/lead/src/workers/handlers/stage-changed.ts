import type { Knex } from 'knex';
import type { OrthoEvent } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import * as leadRepository from '../../repositories/lead-repository.js';
import * as activityRepository from '../../repositories/activity-repository.js';
import { calculateScore } from '../../scoring/score-calculator.js';

const log = createLogger('crm-lead');

export async function handleStageChanged(
  event: OrthoEvent,
  db: Knex,
): Promise<void> {
  const payload = event.payload;

  const lead_id = String(payload.lead_id);
  const pipeline = String(payload.pipeline);
  const stage_to = String(payload.stage_to);
  const occurred_at = payload.transitioned_at
    ? new Date(String(payload.transitioned_at))
    : new Date();

  const lead = await leadRepository.findById(db, lead_id);
  if (!lead) {
    log.warn({ lead_id }, 'stage_changed: lead not found, skipping');
    return;
  }

  await db.transaction(async (trx) => {
    // 1. Update pipeline cache
    await trx.raw(
      `UPDATE crm_leads.leads SET current_pipeline = ?, current_stage = ?, updated_at = now() WHERE id = ?`,
      [pipeline, stage_to, lead_id],
    );

    // 2. Fetch lastInboundAt
    const lastInboundAt = await activityRepository.findLastInboundAt(trx, lead_id);

    // 3. Recalculate score
    const newScore = calculateScore({
      lead: {
        ...lead,
        current_pipeline: pipeline,
        current_stage: stage_to,
        last_activity_at: lead.last_activity_at ? new Date(lead.last_activity_at) : null,
      },
      eventType: 'lead.stage_changed',
      lastInboundAt,
    });

    // 4. Update score
    await trx.raw(
      `UPDATE crm_leads.leads SET score = ?, updated_at = now() WHERE id = ?`,
      [newScore, lead_id],
    );

    // 5. Insert activity
    await activityRepository.insertActivity(trx, {
      lead_id,
      event_type: 'lead.stage_changed',
      actor_type: 'system',
      actor_id: null,
      payload: event.payload as Record<string, unknown>,
      occurred_at: occurred_at.toISOString(),
      source_event_id: event.event_id ?? `fallback:stage_changed:${lead_id}:${occurred_at.toISOString()}`,
    });
  });
}
