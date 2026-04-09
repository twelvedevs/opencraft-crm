import type { Knex } from 'knex';
import * as referrerRepo from '../repositories/referrer.repo.js';
import * as referralLinkRepo from '../repositories/referral-link.repo.js';
import * as linkService from './link.service.js';
import { env } from '../env.js';

interface CreateDoctorReferrerBody {
  name: string;
  location_id: string;
  phone?: string | null;
  email?: string | null;
  practice_name?: string | null;
  address?: string | null;
  created_by?: string;
}

export async function createDoctorReferrer(
  db: Knex,
  body: CreateDoctorReferrerBody,
) {
  const referrer = await referrerRepo.create(db, {
    referrer_type: 'doctor',
    lead_id: null,
    location_id: body.location_id,
    name: body.name,
    phone: body.phone ?? null,
    email: body.email ?? null,
    practice_name: body.practice_name ?? null,
    address: body.address ?? null,
    created_by: body.created_by ?? null,
  });

  const link = await linkService.createLink(
    db,
    referrer.id,
    env.DEFAULT_REFERRAL_LANDING_URL,
    body.created_by,
  );

  return { referrer, link };
}

interface UpdateDoctorInfoBody {
  name?: string;
  phone?: string | null;
  email?: string | null;
  practice_name?: string | null;
  address?: string | null;
}

export async function updateDoctorInfo(
  db: Knex,
  id: string,
  body: UpdateDoctorInfoBody,
) {
  return referrerRepo.update(db, id, body);
}

export async function updateStatus(
  db: Knex,
  id: string,
  status: string,
) {
  return referrerRepo.updateStatus(db, id, status);
}

export async function getWithSummary(db: Knex, id: string) {
  const referrer = await referrerRepo.findById(db, id);
  if (!referrer) return null;

  const activeLink = await referralLinkRepo.findActiveByReferrerId(db, id);

  const [counts] = await db('referrals')
    .where({ referrer_id: id })
    .select(
      db.raw('COUNT(*)::int as total_referrals'),
      db.raw("COUNT(*) FILTER (WHERE status IN ('exam_scheduled', 'converted'))::int as exams_scheduled"),
      db.raw("COUNT(*) FILTER (WHERE status = 'converted')::int as cases_started"),
    );

  return {
    ...referrer,
    active_link: activeLink,
    summary: {
      total_referrals: counts?.total_referrals ?? 0,
      exams_scheduled: counts?.exams_scheduled ?? 0,
      cases_started: counts?.cases_started ?? 0,
    },
  };
}

export async function list(
  db: Knex,
  filters: {
    location_id: string;
    referrer_type?: string;
    status?: string;
    cursor?: string;
    limit?: number;
  },
) {
  return referrerRepo.findByLocationAndType(db, filters);
}
