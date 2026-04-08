import type { Knex } from 'knex';
import type { Conversation } from '../repositories/conversations.repo.js';
import * as conversationsRepo from '../repositories/conversations.repo.js';
import { getEffectiveSettings } from '../repositories/settings.repo.js';

export async function resolveConversation(
  db: Knex,
  opts: {
    leadId: string;
    locationId: string;
    practiceNumber: string;
    leadPhone: string;
  },
): Promise<Conversation> {
  const settings = await getEffectiveSettings(db, opts.locationId);

  const afterTimestamp = new Date(
    Date.now() - settings.inactivity_days * 24 * 60 * 60 * 1000,
  );

  const existing = await conversationsRepo.findRecent(
    db,
    opts.leadId,
    opts.practiceNumber,
    afterTimestamp,
  );

  if (existing) {
    // Reopen if closed
    if (existing.status === 'closed') {
      return conversationsRepo.update(db, existing.id, { status: 'open' });
    }

    return existing;
  }

  return conversationsRepo.create(db, {
    lead_id: opts.leadId,
    location_id: opts.locationId,
    practice_number: opts.practiceNumber,
    lead_phone: opts.leadPhone,
  });
}
