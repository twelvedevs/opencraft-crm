import type { Knex } from 'knex';
import * as referralRepo from '../repositories/referral.repo.js';

interface CreateFromEventPayload {
  referral_link_id: string;
  referrer_id: string;
  lead_id: string;
  location_id: string;
}

export async function createFromEvent(db: Knex, payload: CreateFromEventPayload) {
  return referralRepo.create(db, payload);
}

export async function advanceToExamScheduled(
  db: Knex,
  leadId: string,
  transitionedAt: string,
) {
  const referral = await referralRepo.findByLeadId(db, leadId);
  if (!referral) return null;

  return referralRepo.updateStatus(db, referral.id, {
    status: 'exam_scheduled',
    exam_scheduled_at: transitionedAt,
  });
}

export async function advanceToConverted(
  db: Knex,
  leadId: string,
  convertedAt: string,
) {
  const referral = await referralRepo.findByLeadId(db, leadId);
  if (!referral) return null;

  return referralRepo.updateStatus(db, referral.id, {
    status: 'converted',
    converted_at: convertedAt,
  });
}

export async function updateNotificationPrefs(
  db: Knex,
  id: string,
  prefs: { notify_on_exam?: boolean; notify_on_conversion?: boolean },
) {
  const [row] = await db('referrals')
    .where({ id })
    .update({ ...prefs, updated_at: db.fn.now() })
    .returning('*');
  return row;
}

export async function getById(db: Knex, id: string) {
  return referralRepo.findById(db, id);
}

export async function list(
  db: Knex,
  filters: {
    location_id: string;
    referrer_id?: string;
    status?: string;
    created_after?: string;
    created_before?: string;
    cursor?: string;
    limit?: number;
  },
) {
  return referralRepo.findByLocationId(db, filters);
}
