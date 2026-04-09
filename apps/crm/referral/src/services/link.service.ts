import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import * as referralLinkRepo from '../repositories/referral-link.repo.js';
import * as referrerRepo from '../repositories/referrer.repo.js';

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CODE_LENGTH = 8;
const MAX_RETRIES = 5;

export function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CHARSET[bytes[i] % CHARSET.length];
  }
  return code;
}

export async function createLink(
  db: Knex,
  referrerId: string,
  redirectUrl: string,
  createdBy?: string,
): Promise<{ id: string; code: string; redirect_url: string }> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const code = generateCode();
    const existing = await referralLinkRepo.findByCode(db, code);
    if (existing) continue;

    const link = await referralLinkRepo.create(db, {
      referrer_id: referrerId,
      code,
      redirect_url: redirectUrl,
      created_by: createdBy ?? null,
    });

    return { id: link.id, code: link.code, redirect_url: link.redirect_url };
  }

  throw Object.assign(new Error('Failed to generate unique referral code after 5 attempts'), {
    statusCode: 500,
  });
}

export async function deactivateAllForReferrer(
  db: Knex,
  referrerId: string,
): Promise<void> {
  await referralLinkRepo.deactivateAllForReferrer(db, referrerId);
}

export interface ResolvedCode {
  referrer_id: string;
  referral_link_id: string;
  referrer_type: string;
  referrer_name: string;
}

export async function resolveCode(
  db: Knex,
  code: string,
): Promise<ResolvedCode | null> {
  const link = await referralLinkRepo.findByCode(db, code);
  if (!link || link.status !== 'active') return null;

  const referrer = await referrerRepo.findById(db, link.referrer_id);
  if (!referrer) return null;

  return {
    referrer_id: referrer.id,
    referral_link_id: link.id,
    referrer_type: referrer.referrer_type,
    referrer_name: referrer.name,
  };
}

export async function recordClick(db: Knex, code: string): Promise<void> {
  referralLinkRepo.incrementClickCount(db, code);
}
