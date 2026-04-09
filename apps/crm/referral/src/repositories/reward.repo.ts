import type { Knex } from 'knex';

export interface RewardEvent {
  id: string;
  referral_id: string;
  referrer_id: string;
  status: string;
  reward_type: string | null;
  reward_amount: number | null;
  reward_notes: string | null;
  issued_at: Date | null;
  issued_by: string | null;
  created_at: Date;
}

const TABLE = 'reward_events';

interface CursorData {
  lastSeenId: string;
  lastSeenCreatedAt: string;
}

function decodeCursor(cursor: string): CursorData {
  const json = Buffer.from(cursor, 'base64').toString('utf-8');
  return JSON.parse(json) as CursorData;
}

function encodeCursor(data: CursorData): string {
  return Buffer.from(JSON.stringify(data)).toString('base64');
}

export async function findById(db: Knex, id: string): Promise<RewardEvent | null> {
  const row = await db(TABLE).where({ id }).first();
  return (row as RewardEvent) ?? null;
}

export async function findByReferralId(db: Knex, referralId: string): Promise<RewardEvent | null> {
  const row = await db(TABLE).where({ referral_id: referralId }).first();
  return (row as RewardEvent) ?? null;
}

export async function listByStatus(
  db: Knex,
  params: {
    location_id: string;
    status?: string;
    referrer_id?: string;
    cursor?: string;
    limit?: number;
  },
): Promise<{ items: RewardEvent[]; nextCursor: string | null }> {
  const effectiveLimit = Math.min(params.limit ?? 50, 200);

  let query = db(TABLE)
    .join('referrals', 'referrals.id', `${TABLE}.referral_id`)
    .where('referrals.location_id', params.location_id)
    .select(`${TABLE}.*`);

  if (params.status) {
    query = query.where(`${TABLE}.status`, params.status);
  }
  if (params.referrer_id) {
    query = query.where(`${TABLE}.referrer_id`, params.referrer_id);
  }

  if (params.cursor) {
    const decoded = decodeCursor(params.cursor);
    query = query.whereRaw(
      `(${TABLE}.created_at, ${TABLE}.id) > (?, ?)`,
      [decoded.lastSeenCreatedAt, decoded.lastSeenId],
    );
  }

  query = query.orderBy(`${TABLE}.created_at`, 'asc').orderBy(`${TABLE}.id`, 'asc');
  query = query.limit(effectiveLimit + 1);

  const rows = (await query) as RewardEvent[];

  let nextCursor: string | null = null;
  if (rows.length > effectiveLimit) {
    rows.pop();
    const lastRow = rows[rows.length - 1];
    nextCursor = encodeCursor({
      lastSeenId: lastRow.id,
      lastSeenCreatedAt: lastRow.created_at as unknown as string,
    });
  }

  return { items: rows, nextCursor };
}

export async function create(
  db: Knex,
  data: {
    referral_id: string;
    referrer_id: string;
  },
): Promise<RewardEvent | null> {
  const rows = await db(TABLE)
    .insert(data)
    .onConflict('referral_id')
    .ignore()
    .returning('*');
  return (rows[0] as RewardEvent) ?? null;
}

export async function markIssued(
  db: Knex,
  id: string,
  data: {
    reward_type: string;
    reward_amount?: number | null;
    reward_notes?: string | null;
    issued_by: string;
  },
): Promise<RewardEvent> {
  const [row] = await db(TABLE)
    .where({ id })
    .update({
      status: 'issued',
      reward_type: data.reward_type,
      reward_amount: data.reward_amount ?? null,
      reward_notes: data.reward_notes ?? null,
      issued_by: data.issued_by,
      issued_at: db.fn.now(),
    })
    .returning('*');
  return row as RewardEvent;
}
