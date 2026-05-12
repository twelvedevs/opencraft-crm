import type { Knex } from 'knex';
import type { OrthoEvent } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import { normalizePhone } from '../../services/lead-service.js';
import * as leadRepository from '../../repositories/lead-repository.js';
import * as activityRepository from '../../repositories/activity-repository.js';
import { calculateScore } from '../../scoring/score-calculator.js';

const log = createLogger('crm-lead');

export async function handleMessageDelivered(
  event: OrthoEvent,
  db: Knex,
): Promise<void> {
  const payload = event.payload;

  const to_number = String(payload.to_number);

  let normalizedPhone: string;
  try {
    normalizedPhone = normalizePhone(to_number);
  } catch {
    log.warn({ to_number }, 'message.delivered: invalid phone, skipping');
    return;
  }

  const leads = await leadRepository.findByPhone(db, normalizedPhone);
  if (leads.length === 0) {
    log.warn({ to_number: normalizedPhone }, 'message.delivered: no lead found');
    return;
  }

  const lead = leads[0];
  const lead_id = lead.id;

  await db.transaction(async (trx) => {
    // 1. Fetch lastInboundAt
    const lastInboundAt = await activityRepository.findLastInboundAt(trx, lead_id);

    // 2. Recalculate score
    const newScore = calculateScore({
      lead: {
        ...lead,
        last_activity_at: lead.last_activity_at ? new Date(lead.last_activity_at) : null,
      },
      eventType: 'message.delivered',
      lastInboundAt,
    });

    // 3. Update score
    await trx.raw(
      `UPDATE crm_leads.leads SET score = ?, updated_at = now() WHERE id = ?`,
      [newScore, lead_id],
    );

    // 4. Insert activity
    const occurred_at = payload.delivered_at
      ? new Date(String(payload.delivered_at))
      : new Date();

    await activityRepository.insertActivity(trx, {
      lead_id,
      event_type: 'message.delivered',
      actor_type: 'system',
      actor_id: null,
      payload: event.payload as Record<string, unknown>,
      occurred_at: occurred_at.toISOString(),
      source_event_id: event.event_id ?? `fallback:message.delivered:${String(payload.message_id)}`,
    });
  });
}
