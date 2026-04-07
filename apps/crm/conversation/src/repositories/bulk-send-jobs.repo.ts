import type { Knex } from 'knex';

export interface BulkSendJob {
  id: string;
  location_id: string;
  segment: unknown;
  body: string;
  status: string;
  total: number | null;
  sent: number;
  failed: number;
  created_by: string;
  created_at: Date;
  completed_at: Date | null;
}

const TABLE = 'bulk_send_jobs';

export async function create(
  db: Knex,
  data: {
    location_id: string;
    segment: unknown;
    body: string;
    created_by: string;
  },
): Promise<BulkSendJob> {
  const [row] = await db(TABLE)
    .insert({ ...data, segment: JSON.stringify(data.segment) })
    .returning('*');
  return row as BulkSendJob;
}

export async function updateStatus(
  db: Knex,
  id: string,
  status: string,
  extra?: {
    total?: number;
    sent?: number;
    failed?: number;
    completed_at?: Date;
  },
): Promise<void> {
  const updateData: Record<string, unknown> = { status };
  if (extra) {
    if (extra.total !== undefined) updateData.total = extra.total;
    if (extra.sent !== undefined) updateData.sent = extra.sent;
    if (extra.failed !== undefined) updateData.failed = extra.failed;
    if (extra.completed_at !== undefined) updateData.completed_at = extra.completed_at;
  }
  await db(TABLE).where({ id }).update(updateData);
}

export async function findById(
  db: Knex,
  id: string,
): Promise<BulkSendJob | null> {
  const row = await db(TABLE).where({ id }).first();
  return (row as BulkSendJob) ?? null;
}
