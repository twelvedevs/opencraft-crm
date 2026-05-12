import type { Knex } from 'knex';
import type { OrthoEvent } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import { normalizePhone } from '../../services/lead-service.js';
import * as leadRepository from '../../repositories/lead-repository.js';
import * as activityRepository from '../../repositories/activity-repository.js';

const log = createLogger('crm-lead');

export async function handleMessageFailed(
  event: OrthoEvent,
  db: Knex,
): Promise<void> {
  const payload = event.payload;

  const to_number = String(payload.to_number);

  let normalizedPhone: string;
  try {
    normalizedPhone = normalizePhone(to_number);
  } catch {
    log.warn({ to_number }, 'message.failed: invalid phone, skipping');
    return;
  }

  const leads = await leadRepository.findByPhone(db, normalizedPhone);
  if (leads.length === 0) {
    log.warn({ to_number: normalizedPhone }, 'message.failed: no lead found');
    return;
  }

  const lead = leads[0];
  const lead_id = lead.id;

  // Timeline entry only — no score update, no state update
  await db.transaction(async (trx) => {
    await activityRepository.insertActivity(trx, {
      lead_id,
      event_type: 'message.failed',
      actor_type: 'system',
      actor_id: null,
      payload: event.payload as Record<string, unknown>,
      occurred_at: new Date().toISOString(),
      source_event_id: event.event_id ?? `fallback:message.failed:${String(payload.message_id)}`,
    });
  });
}
