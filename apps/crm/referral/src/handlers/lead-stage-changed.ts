import type { Knex } from 'knex';
import type { OrthoEvent } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import * as referralService from '../services/referral.service.js';
import * as referrerRepo from '../repositories/referrer.repo.js';
import * as notificationService from '../services/notification.service.js';

const log = createLogger('crm-referral');

export async function handleLeadStageChanged(
  event: OrthoEvent,
  db: Knex,
): Promise<void> {
  const payload = event.payload;

  const pipeline = String(payload.pipeline);
  const stage_to = String(payload.stage_to);

  // Only care about new_patient pipeline, exam_scheduled stage
  if (pipeline !== 'new_patient' || stage_to !== 'exam_scheduled') return;

  const lead_id = String(payload.lead_id);
  const transitioned_at = String(payload.transitioned_at);

  // Advance referral status — returns null if no referral for this lead
  const referral = await referralService.advanceToExamScheduled(db, lead_id, transitioned_at);
  if (!referral) return;

  // Look up referrer for notification
  const referrer = await referrerRepo.findById(db, referral.referrer_id);
  if (!referrer) {
    log.warn({ referrer_id: referral.referrer_id, lead_id }, 'lead-stage-changed: referrer not found');
    return;
  }

  // Send SMS notification — dedup_key prevents duplicates on redelivery
  await notificationService.sendExamNotification(referral, referrer);
}
