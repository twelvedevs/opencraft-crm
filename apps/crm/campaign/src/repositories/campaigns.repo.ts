import type { Knex } from 'knex';

export interface Campaign {
  id: string;
  name: string;
  status: string;
  template_id: string;
  subject: string | null;
  segment_id: string | null;
  audience_filter: Record<string, unknown> | null;
  audience_snapshot_id: string | null;
  scheduled_for: Date | null;
  orchestrate_job_id: string | null;
  ab_enabled: boolean;
  ab_mode: string | null;
  ab_test_split_pct: number | null;
  ab_winner_delay_hours: number;
  ab_variant_a_subject: string | null;
  ab_variant_b_subject: string | null;
  ab_phase: string | null;
  ab_winner: string | null;
  ab_decision_at: Date | null;
  ab_opens_a: number;
  ab_opens_b: number;
  ab_winner_job_id: string | null;
  created_by: string;
  approved_by: string | null;
  approved_at: Date | null;
  sent_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const TABLE = 'campaigns';

export async function findById(db: Knex, id: string): Promise<Campaign | null> {
  const row = await db(TABLE).where({ id }).first();
  return (row as Campaign) ?? null;
}

export async function create(
  db: Knex,
  data: {
    name: string;
    template_id: string;
    subject?: string | null;
    segment_id?: string | null;
    audience_filter?: Record<string, unknown> | null;
    ab_enabled?: boolean;
    ab_mode?: string | null;
    ab_test_split_pct?: number | null;
    ab_winner_delay_hours?: number;
    ab_variant_a_subject?: string | null;
    ab_variant_b_subject?: string | null;
    created_by: string;
  },
): Promise<Campaign> {
  const [row] = await db(TABLE).insert(data).returning('*');
  return row as Campaign;
}

export async function update(
  db: Knex,
  id: string,
  data: Partial<Omit<Campaign, 'id' | 'created_at'>>,
): Promise<Campaign> {
  const [row] = await db(TABLE)
    .where({ id })
    .update({ ...data, updated_at: db.fn.now() })
    .returning('*');
  return row as Campaign;
}

export async function list(
  db: Knex,
  filters: {
    status?: string[];
    created_by?: string;
    limit: number;
    offset: number;
  },
): Promise<{ items: Campaign[]; total: number }> {
  let countQuery = db(TABLE);
  if (filters.status && filters.status.length > 0) {
    countQuery = countQuery.whereIn('status', filters.status);
  }
  if (filters.created_by) {
    countQuery = countQuery.where('created_by', filters.created_by);
  }

  const [{ count }] = await countQuery.count('* as count');
  const total = Number(count);

  let query = db(TABLE);
  if (filters.status && filters.status.length > 0) {
    query = query.whereIn('status', filters.status);
  }
  if (filters.created_by) {
    query = query.where('created_by', filters.created_by);
  }

  const rows = await query
    .orderBy('created_at', 'desc')
    .limit(filters.limit)
    .offset(filters.offset);

  return { items: rows as Campaign[], total };
}

export async function incrementAbOpens(
  db: Knex,
  id: string,
  variant: 'A' | 'B',
): Promise<void> {
  const col = variant === 'A' ? 'ab_opens_a' : 'ab_opens_b';
  await db(TABLE)
    .where({ id })
    .update({ [col]: db.raw(`${col} + 1`) });
}

export async function remove(db: Knex, id: string): Promise<void> {
  await db(TABLE).where({ id }).delete();
}
