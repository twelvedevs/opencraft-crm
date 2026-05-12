import type { Knex } from 'knex';
import type { OrthoEvent } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import * as referralLinkRepo from '../repositories/referral-link.repo.js';
import * as referralService from '../services/referral.service.js';

const log = createLogger('crm-referral');

export async function handleLeadCreated(
  event: OrthoEvent,
  db: Knex,
): Promise<void> {
  const payload = event.payload;

  const referrer_id = payload.referrer_id ? String(payload.referrer_id) : null;
  const referral_code = payload.referral_code ? String(payload.referral_code) : null;

  if (!referrer_id || !referral_code) return;

  const lead_id = String(payload.lead_id);
  const location_id = String(payload.location_id);

  // Resolve referral_link_id from the specific code in the payload
  const link = await referralLinkRepo.findByCode(db, referral_code);
  if (!link) {
    log.warn({ referral_code, lead_id }, 'lead-created: referral code not found in DB, skipping');
    return;
  }

  // Insert referral row — ON CONFLICT lead_id DO NOTHING for idempotency
  await referralService.createFromEvent(db, {
    referral_link_id: link.id,
    referrer_id,
    lead_id,
    location_id,
  });
}
