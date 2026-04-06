import type { Knex } from 'knex';
import type { OrthoEvent } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import * as leadRepository from '../../repositories/lead-repository.js';
import * as activityRepository from '../../repositories/activity-repository.js';
import { calculateScore } from '../../scoring/score-calculator.js';
import { applyHardBounce, type ContactStatus } from '../../scoring/contact-status.js';

const log = createLogger('crm-lead');

export async function handleEmailBounced(
  event: OrthoEvent,
  db: Knex,
): Promise<void> {
  const payload = event.payload;

  const to_address = String(payload.to_address);
  const bounce_type = String(payload.bounce_type);

  // Soft bounces do NOT change contact_status or score
  if (bounce_type !== 'hard') {
    return;
  }

  const leads = await leadRepository.findByEmail(db, to_address);
  if (leads.length === 0) {
    log.warn({ to_address }, 'email.bounced: no lead found');
    return;
  }

  const lead = leads[0];
  const lead_id = lead.id;

  await db.transaction(async (trx) => {
    // 1. Apply hard bounce transition
    const newStatus = applyHardBounce(lead.contact_status as ContactStatus);

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
      eventType: 'email.bounced',
      lastInboundAt,
    });

    // 5. Update score
    await trx.raw(
      `UPDATE crm_leads.leads SET score = ?, updated_at = now() WHERE id = ?`,
      [newScore, lead_id],
    );

    // 6. Insert activity
    await activityRepository.insertActivity(trx, {
      lead_id,
      event_type: 'email.bounced',
      actor_type: 'system',
      actor_id: null,
      payload: event.payload as Record<string, unknown>,
      occurred_at: new Date().toISOString(),
      source_event_id: event.event_id ?? `fallback:email.bounced:${lead_id}`,
    });
  });
}
