import type { Knex } from 'knex';
import type { OrthoEvent } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import * as leadRepository from '../../repositories/lead-repository.js';
import * as activityRepository from '../../repositories/activity-repository.js';
import { calculateScore } from '../../scoring/score-calculator.js';

const log = createLogger('crm-lead');

export async function handleLeadArchived(
  event: OrthoEvent,
  db: Knex,
): Promise<void> {
  const payload = event.payload;

  const lead_id = String(payload.lead_id);
  const occurred_at = payload.occurred_at
    ? new Date(String(payload.occurred_at))
    : new Date();

  const lead = await leadRepository.findById(db, lead_id);
  if (!lead) {
    log.warn({ lead_id }, 'lead.archived: lead not found, skipping');
    return;
  }

  await db.transaction(async (trx) => {
    // 1. Clear pipeline cache
    await trx.raw(
      `UPDATE crm_leads.leads SET current_pipeline = 'none', current_stage = NULL, updated_at = now() WHERE id = ?`,
      [lead_id],
    );

    // 2. Fetch lastInboundAt
    const lastInboundAt = await activityRepository.findLastInboundAt(trx, lead_id);

    // 3. Recalculate score
    const newScore = calculateScore({
      lead: {
        ...lead,
        current_pipeline: 'none',
        current_stage: null,
        last_activity_at: lead.last_activity_at ? new Date(lead.last_activity_at) : null,
      },
      eventType: 'lead.archived',
      lastInboundAt,
    });

    // 4. Update score
    await trx.raw(
      `UPDATE crm_leads.leads SET score = ?, updated_at = now() WHERE id = ?`,
      [newScore, lead_id],
    );

    // 5. Insert activity — ON CONFLICT DO NOTHING handles idempotency with HTTP route
    await activityRepository.insertActivity(trx, {
      lead_id,
      event_type: 'lead.archived',
      actor_type: 'system',
      actor_id: null,
      payload: {},
      occurred_at: occurred_at.toISOString(),
      source_event_id: `internal:lead.archived:${lead_id}`,
    });
  });
}
