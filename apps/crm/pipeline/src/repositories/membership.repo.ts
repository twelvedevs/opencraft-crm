import type { Knex } from 'knex';

export interface Membership {
  id: string;
  lead_id: string;
  location_id: string;
  pipeline: string;
  stage: string;
  status: string;
  entered_stage_at: Date;
  timeout_at: Date | null;
  previous_stage: string | null;
  last_transition_override: boolean;
  closed_at: Date | null;
  closed_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ListFilters {
  lead_id?: string;
  pipeline?: string;
  stage?: string;
  location_id?: string;
  status?: string;
  cursor?: string;
  limit?: number;
}

function decodeCursor(cursor: string): { id: string; created_at: string } {
  return JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));
}

function encodeCursor(row: Membership): string {
  return Buffer.from(JSON.stringify({ id: row.id, created_at: row.created_at })).toString('base64');
}

const TABLE = 'pipeline_memberships';

export async function findById(db: Knex, id: string): Promise<Membership | null> {
  const row = await db(TABLE).where({ id }).first();
  return (row as Membership) ?? null;
}

export async function findWithLock(db: Knex, id: string): Promise<Membership | null> {
  const result = await db.raw(
    'SELECT * FROM pipeline_memberships WHERE id = ? FOR UPDATE',
    [id],
  );
  const row = result.rows?.[0] ?? null;
  return row as Membership | null;
}

export async function findActiveByLeadAndPipeline(
  db: Knex,
  leadId: string,
  pipeline: string,
): Promise<Membership | null> {
  const row = await db(TABLE)
    .where({ lead_id: leadId, pipeline, status: 'active' })
    .first();
  return (row as Membership) ?? null;
}

export async function listMemberships(
  db: Knex,
  filters: ListFilters,
): Promise<{ rows: Membership[]; nextCursor: string | null }> {
  const limit = filters.limit ?? 50;

  let query = db(TABLE).orderBy([
    { column: 'created_at', order: 'asc' },
    { column: 'id', order: 'asc' },
  ]);

  if (filters.lead_id) query = query.where('lead_id', filters.lead_id);
  if (filters.pipeline) query = query.where('pipeline', filters.pipeline);
  if (filters.stage) query = query.where('stage', filters.stage);
  if (filters.location_id) query = query.where('location_id', filters.location_id);
  if (filters.status) query = query.where('status', filters.status);

  if (filters.cursor) {
    const decoded = decodeCursor(filters.cursor);
    query = query.where(function (this: Knex.QueryBuilder) {
      this.where('created_at', '>', decoded.created_at).orWhere(function () {
        this.where('created_at', '=', decoded.created_at).andWhere('id', '>', decoded.id);
      });
    });
  }

  const rows = (await query.limit(limit)) as Membership[];
  const nextCursor = rows.length === limit ? encodeCursor(rows[rows.length - 1]) : null;

  return { rows, nextCursor };
}

export async function createMembership(
  db: Knex,
  data: {
    lead_id: string;
    location_id: string;
    pipeline: string;
    stage: string;
    triggered_by?: string | null;
    timeout_at?: Date | null;
    reason?: string;
  },
): Promise<Membership> {
  const [row] = await db(TABLE)
    .insert({
      lead_id: data.lead_id,
      location_id: data.location_id,
      pipeline: data.pipeline,
      stage: data.stage,
      timeout_at: data.timeout_at ?? null,
      entered_stage_at: db.fn.now(),
    })
    .returning('*');
  return row as Membership;
}

export async function updateStage(
  db: Knex,
  id: string,
  data: {
    stage: string;
    timeout_at: Date | null;
    override: boolean;
    previous_stage: string;
  },
): Promise<Membership> {
  const [row] = await db(TABLE)
    .where({ id })
    .update({
      stage: data.stage,
      entered_stage_at: db.fn.now(),
      timeout_at: data.timeout_at,
      previous_stage: data.previous_stage,
      last_transition_override: data.override,
      updated_at: db.fn.now(),
    })
    .returning('*');
  return row as Membership;
}

export async function setStatus(
  db: Knex,
  id: string,
  data: {
    status: string;
    closed_reason: string | null;
    closed_at: Date | null;
  },
): Promise<Membership> {
  const [row] = await db(TABLE)
    .where({ id })
    .update({
      status: data.status,
      closed_reason: data.closed_reason,
      closed_at: data.closed_at,
      updated_at: db.fn.now(),
    })
    .returning('*');
  return row as Membership;
}
