import type { Knex } from 'knex';
import type { OrthoEvent, EventBus } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import * as referralService from '../services/referral.service.js';
import * as referrerRepo from '../repositories/referrer.repo.js';
import * as rewardRepo from '../repositories/reward.repo.js';
import * as notificationService from '../services/notification.service.js';
import * as linkService from '../services/link.service.js';
import * as leadServiceClient from '../clients/lead-service.client.js';
import { publishReferralConverted, publishReferrerCreated } from '../events/publisher.js';
import { env } from '../env.js';

const log = createLogger('crm-referral');

export async function handleLeadConverted(
  event: OrthoEvent,
  db: Knex,
  bus: EventBus,
): Promise<void> {
  const payload = event.payload;
  const to_pipeline = String(payload.to_pipeline);
  const lead_id = String(payload.lead_id);
  const location_id = String(payload.location_id);

  if (to_pipeline === 'in_treatment') {
    await handleBranchA(lead_id, location_id, payload, db, bus);
  } else if (to_pipeline === 'in_retention') {
    await handleBranchB(lead_id, location_id, db, bus);
  }
}

/**
 * Branch A: contract signed → in_treatment
 * Advance referral to converted, create reward, notify, publish event.
 */
async function handleBranchA(
  lead_id: string,
  location_id: string,
  payload: Record<string, unknown>,
  db: Knex,
  bus: EventBus,
): Promise<void> {
  const converted_at = String(payload.converted_at);

  const referral = await referralService.advanceToConverted(db, lead_id, converted_at);
  if (!referral) return;

  // Create reward_events row (ON CONFLICT referral_id DO NOTHING)
  await rewardRepo.create(db, {
    referral_id: referral.id,
    referrer_id: referral.referrer_id,
  });

  // Look up referrer for notification
  const referrer = await referrerRepo.findById(db, referral.referrer_id);
  if (referrer) {
    await notificationService.sendConversionNotification(referral, referrer);
  }

  // Publish referral.converted event
  await publishReferralConverted(bus, {
    referral_id: referral.id,
    lead_id: referral.lead_id,
    referrer_id: referral.referrer_id,
    referrer_type: referrer?.referrer_type ?? 'unknown',
    location_id: referral.location_id,
    converted_at,
  });
}

/**
 * Branch B: treatment complete → in_retention
 * Create patient referrer + link, publish referrer.created.
 */
async function handleBranchB(
  lead_id: string,
  location_id: string,
  db: Knex,
  bus: EventBus,
): Promise<void> {
  // Idempotent: skip if referrer already exists for this lead
  const existing = await referrerRepo.findByLeadId(db, lead_id);
  if (existing) return;

  // Fetch lead info from Lead Service — rethrow on failure (dead-letters the job)
  const leadInfo = await leadServiceClient.getLeadById(lead_id);

  const name = `${leadInfo.first_name} ${leadInfo.last_name}`;

  // Create patient referrer
  const referrer = await referrerRepo.create(db, {
    referrer_type: 'patient',
    lead_id,
    location_id,
    name,
    phone: leadInfo.phone,
    email: null,
    practice_name: null,
    address: null,
    created_by: null,
  });

  // Generate referral link
  const link = await linkService.createLink(
    db,
    referrer.id,
    env.DEFAULT_REFERRAL_LANDING_URL,
  );

  // Publish referrer.created with referral_link_url = REFERRAL_BASE_URL + '/referrals/r/' + code
  const referral_link_url = `${env.REFERRAL_BASE_URL}/referrals/r/${link.code}`;

  await publishReferrerCreated(bus, {
    referrer_id: referrer.id,
    referrer_type: 'patient',
    lead_id,
    location_id,
    referral_link_id: link.id,
    referral_code: link.code,
    referral_link_url,
    created_at: referrer.created_at as unknown as string,
  });
}
