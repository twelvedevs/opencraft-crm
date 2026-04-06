import type { Knex } from 'knex';
import type { OrthoEvent } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import { normalizePhone } from '../../services/lead-service.js';
import * as leadRepository from '../../repositories/lead-repository.js';
import * as activityRepository from '../../repositories/activity-repository.js';
import { calculateScore } from '../../scoring/score-calculator.js';
import { removeOptOut, type ContactStatus } from '../../scoring/contact-status.js';

const log = createLogger('crm-lead');

export async function handleOptOutRemoved(
  event: OrthoEvent,
  db: Knex,
): Promise<void> {
  const payload = event.payload;

  const phone_number = String(payload.phone_number);

  let normalizedPhone: string;
  try {
    normalizedPhone = normalizePhone(phone_number);
  } catch {
    log.warn({ phone_number }, 'opt_out.removed: invalid phone, skipping');
    return;
  }

  const leads = await leadRepository.findByPhone(db, normalizedPhone);
  if (leads.length === 0) {
    log.warn({ phone: normalizedPhone }, 'opt_out.removed: no lead found');
    return;
  }

  const lead = leads[0];
  const lead_id = lead.id;

  await db.transaction(async (trx) => {
    // 1. Apply opt-out removal transition
    const newStatus = removeOptOut(lead.contact_status as ContactStatus);

    // 2. Update contact_status
    await trx.raw(
      `UPDATE crm_leads.leads SET contact_status = ?, updated_at = now() WHERE id = ?`,
      [newStatus, lead_id],
    );

    // 3. Fetch lastInboundAt
    const lastInboundAt = await activityRepository.findLastInboundAt(trx, lead_id);

    // 4. Recalculate score
    const newScore = calculateScore({
      lead: {
        ...lead,
        contact_status: newStatus,
        last_activity_at: lead.last_activity_at ? new Date(lead.last_activity_at) : null,
      },
      eventType: 'opt_out.removed',
      lastInboundAt,
    });

    // 5. Update score
    await trx.raw(
      `UPDATE crm_leads.leads SET score = ?, updated_at = now() WHERE id = ?`,
      [newScore, lead_id],
    );

    // 6. Insert activity
    const occurred_at = payload.removed_at
      ? new Date(String(payload.removed_at))
      : new Date();

    await activityRepository.insertActivity(trx, {
      lead_id,
      event_type: 'opt_out.removed',
      actor_type: 'system',
      actor_id: null,
      payload: event.payload as Record<string, unknown>,
      occurred_at: occurred_at.toISOString(),
      source_event_id: event.event_id ?? `fallback:opt_out.removed:${lead_id}`,
    });
  });
}
