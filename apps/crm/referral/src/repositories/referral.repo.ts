import type { Knex } from 'knex';

export interface Referral {
  id: string;
  referral_link_id: string;
  referrer_id: string;
  lead_id: string;
  location_id: string;
  status: string;
  exam_scheduled_at: Date | null;
  converted_at: Date | null;
  notify_on_exam: boolean;
  notify_on_conversion: boolean;
  created_at: Date;
  updated_at: Date;
}

const TABLE = 'referrals';

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

export async function findByLeadId(db: Knex, leadId: string): Promise<Referral | null> {
  const row = await db(TABLE).where({ lead_id: leadId }).first();
  return (row as Referral) ?? null;
}

export async function findById(db: Knex, id: string): Promise<Referral | null> {
  const row = await db(TABLE).where({ id }).first();
  return (row as Referral) ?? null;
}

export async function findByReferrerId(
  db: Knex,
  params: {
    referrer_id: string;
    status?: string;
    cursor?: string;
    limit?: number;
  },
): Promise<{ items: Referral[]; nextCursor: string | null }> {
  const effectiveLimit = Math.min(params.limit ?? 50, 200);

  let query = db(TABLE).where({ referrer_id: params.referrer_id });

  if (params.status) {
    query = query.where('status', params.status);
  }

  if (params.cursor) {
    const decoded = decodeCursor(params.cursor);
    query = query.whereRaw(
      `(created_at, id) < (?, ?)`,
      [decoded.lastSeenCreatedAt, decoded.lastSeenId],
    );
  }

  query = query.orderBy('created_at', 'desc').orderBy('id', 'desc');
  query = query.limit(effectiveLimit + 1);

  const rows = (await query) as Referral[];

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

export async function findByLocationId(
  db: Knex,
  params: {
    location_id: string;
    referrer_id?: string;
    status?: string;
    created_after?: string;
    created_before?: string;
    cursor?: string;
    limit?: number;
  },
): Promise<{ items: Referral[]; nextCursor: string | null }> {
  const effectiveLimit = Math.min(params.limit ?? 50, 200);

  let query = db(TABLE).where({ location_id: params.location_id });

  if (params.referrer_id) {
    query = query.where('referrer_id', params.referrer_id);
  }
  if (params.status) {
    query = query.where('status', params.status);
  }
  if (params.created_after) {
    query = query.where('created_at', '>=', params.created_after);
  }
  if (params.created_before) {
    query = query.where('created_at', '<=', params.created_before);
  }

  if (params.cursor) {
    const decoded = decodeCursor(params.cursor);
    query = query.whereRaw(
      `(created_at, id) < (?, ?)`,
      [decoded.lastSeenCreatedAt, decoded.lastSeenId],
    );
  }

  query = query.orderBy('created_at', 'desc').orderBy('id', 'desc');
  query = query.limit(effectiveLimit + 1);

  const rows = (await query) as Referral[];

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
  data: Omit<Referral, 'id' | 'status' | 'exam_scheduled_at' | 'converted_at' | 'notify_on_exam' | 'notify_on_conversion' | 'created_at' | 'updated_at'>,
): Promise<Referral | null> {
  const rows = await db(TABLE)
    .insert(data)
    .onConflict('lead_id')
    .ignore()
    .returning('*');
  return (rows[0] as Referral) ?? null;
}

export async function updateStatus(
  db: Knex,
  id: string,
  data: {
    status: string;
    exam_scheduled_at?: string;
    converted_at?: string;
  },
): Promise<Referral> {
  const [row] = await db(TABLE)
    .where({ id })
    .update({ ...data, updated_at: db.fn.now() })
    .returning('*');
  return row as Referral;
}
