import type { Knex } from 'knex';

export interface ReferralLink {
  id: string;
  referrer_id: string;
  code: string;
  redirect_url: string;
  click_count: number;
  status: string;
  created_by: string | null;
  created_at: Date;
}

const TABLE = 'referral_links';

export async function findByCode(db: Knex, code: string): Promise<ReferralLink | null> {
  const row = await db(TABLE).where({ code }).first();
  return (row as ReferralLink) ?? null;
}

export async function findActiveByReferrerId(
  db: Knex,
  referrerId: string,
): Promise<ReferralLink | null> {
  const row = await db(TABLE).where({ referrer_id: referrerId, status: 'active' }).first();
  return (row as ReferralLink) ?? null;
}

export async function findAllByReferrerId(
  db: Knex,
  referrerId: string,
): Promise<ReferralLink[]> {
  const rows = await db(TABLE)
    .where({ referrer_id: referrerId })
    .orderBy('created_at', 'desc');
  return rows as ReferralLink[];
}

export async function create(
  db: Knex,
  data: Omit<ReferralLink, 'id' | 'click_count' | 'status' | 'created_at'>,
): Promise<ReferralLink> {
  const [row] = await db(TABLE).insert(data).returning('*');
  return row as ReferralLink;
}

export async function deactivateAllForReferrer(
  db: Knex,
  referrerId: string,
): Promise<void> {
  await db(TABLE)
    .where({ referrer_id: referrerId, status: 'active' })
    .update({ status: 'inactive' });
}

export async function updateStatus(
  db: Knex,
  id: string,
  status: string,
): Promise<ReferralLink> {
  const [row] = await db(TABLE)
    .where({ id })
    .update({ status })
    .returning('*');
  return row as ReferralLink;
}

export async function incrementClickCount(
  db: Knex,
  code: string,
): Promise<void> {
  try {
    await db(TABLE)
      .where({ code })
      .update({ click_count: db.raw('click_count + 1') });
  } catch {
    // fire-and-forget — does not throw
  }
}
