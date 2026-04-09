import type { Knex } from 'knex';

export interface Referrer {
  id: string;
  referrer_type: string;
  lead_id: string | null;
  location_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  practice_name: string | null;
  address: string | null;
  status: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const TABLE = 'referrers';

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

export async function findById(db: Knex, id: string): Promise<Referrer | null> {
  const row = await db(TABLE).where({ id }).first();
  return (row as Referrer) ?? null;
}

export async function findByLeadId(db: Knex, leadId: string): Promise<Referrer | null> {
  const row = await db(TABLE).where({ lead_id: leadId }).first();
  return (row as Referrer) ?? null;
}

export async function findByLocationAndType(
  db: Knex,
  params: {
    location_id: string;
    referrer_type?: string;
    status?: string;
    cursor?: string;
    limit?: number;
  },
): Promise<{ items: Referrer[]; nextCursor: string | null }> {
  const effectiveLimit = Math.min(params.limit ?? 50, 200);

  let query = db(TABLE).where({ location_id: params.location_id });

  if (params.referrer_type) {
    query = query.where('referrer_type', params.referrer_type);
  }
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

  const rows = (await query) as Referrer[];

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
  data: Omit<Referrer, 'id' | 'status' | 'created_at' | 'updated_at'>,
): Promise<Referrer> {
  const [row] = await db(TABLE).insert(data).returning('*');
  return row as Referrer;
}

export async function update(
  db: Knex,
  id: string,
  data: Partial<Pick<Referrer, 'name' | 'phone' | 'email' | 'practice_name' | 'address'>>,
): Promise<Referrer> {
  const [row] = await db(TABLE)
    .where({ id })
    .update({ ...data, updated_at: db.fn.now() })
    .returning('*');
  return row as Referrer;
}

export async function updateStatus(
  db: Knex,
  id: string,
  status: string,
): Promise<Referrer> {
  const [row] = await db(TABLE)
    .where({ id })
    .update({ status, updated_at: db.fn.now() })
    .returning('*');
  return row as Referrer;
}
