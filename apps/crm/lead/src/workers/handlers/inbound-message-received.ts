import type { Knex } from 'knex';
import type { OrthoEvent } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import { normalizePhone } from '../../services/lead-service.js';
import * as leadRepository from '../../repositories/lead-repository.js';
import * as activityRepository from '../../repositories/activity-repository.js';
import { calculateScore } from '../../scoring/score-calculator.js';

const log = createLogger('crm-lead');

export async function handleInboundMessageReceived(
  event: OrthoEvent,
  db: Knex,
): Promise<void> {
  const payload = event.payload;

  const from_number = String(payload.from_number);

  let normalizedFromNumber: string;
  try {
    normalizedFromNumber = normalizePhone(from_number);
  } catch {
    log.warn({ from_number }, 'inbound_message.received: invalid phone, skipping');
    return;
  }

  const leads = await leadRepository.findByPhone(db, normalizedFromNumber);
  if (leads.length === 0) {
    log.warn({ from_number: normalizedFromNumber }, 'inbound_message.received: no lead found');
    return;
  }

  const lead = leads[0];
  const lead_id = lead.id;

  await db.transaction(async (trx) => {
    // 1. Determine occurred_at
    const occurred_at = payload.received_at
      ? new Date(String(payload.received_at))
      : new Date();

    // 2. Recalculate score — pass occurred_at as lastInboundAt so the just-received message
    // itself satisfies the engagement factor
    const newScore = calculateScore({
      lead: {
        ...lead,
        last_activity_at: lead.last_activity_at ? new Date(lead.last_activity_at) : null,
      },
      eventType: 'inbound_message.received',
      lastInboundAt: occurred_at,
    });

    // 3. Update score
    await trx.raw(
      `UPDATE crm_leads.leads SET score = ?, updated_at = now() WHERE id = ?`,
      [newScore, lead_id],
    );

    // 4. Insert activity
    await activityRepository.insertActivity(trx, {
      lead_id,
      event_type: 'inbound_message.received',
      actor_type: 'system',
      actor_id: null,
      payload: event.payload as Record<string, unknown>,
      occurred_at: occurred_at.toISOString(),
      source_event_id: event.event_id ?? `fallback:inbound_message.received:${String(payload.message_id)}`,
    });
  });
}
