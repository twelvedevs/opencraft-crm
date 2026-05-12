import type { Knex } from 'knex';
import type { ReportConfigBody } from '../schemas/report-config.js';

const TABLE = 'crm_reporting.report_configs';

export interface ReportConfig {
  id: string;
  name: string;
  report_type: string;
  parameters: Record<string, unknown>;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export async function findById(db: Knex, id: string): Promise<ReportConfig | null> {
  const row = await db(TABLE).where({ id }).first();
  return (row as ReportConfig) ?? null;
}

export async function findByCreatedBy(
  db: Knex,
  userId: string,
  typeFilter?: string,
): Promise<ReportConfig[]> {
  let query = db(TABLE).where({ created_by: userId }).orderBy('created_at', 'desc');
  if (typeFilter) {
    query = query.where('report_type', typeFilter);
  }
  return (await query) as ReportConfig[];
}

export async function findAll(db: Knex, typeFilter?: string): Promise<ReportConfig[]> {
  let query = db(TABLE).orderBy('created_at', 'desc');
  if (typeFilter) {
    query = query.where('report_type', typeFilter);
  }
  return (await query) as ReportConfig[];
}

export async function create(
  db: Knex,
  body: ReportConfigBody,
  createdBy: string,
): Promise<ReportConfig> {
  const [row] = await db(TABLE)
    .insert({
      name: body.name,
      report_type: body.report_type,
      parameters: JSON.stringify(body.parameters ?? {}),
      created_by: createdBy,
    })
    .returning('*');
  return row as ReportConfig;
}

export async function update(
  db: Knex,
  id: string,
  body: Partial<ReportConfigBody>,
): Promise<ReportConfig | null> {
  const updates: Record<string, unknown> = { updated_at: db.fn.now() };
  if (body.name !== undefined) updates.name = body.name;
  if (body.report_type !== undefined) updates.report_type = body.report_type;
  if (body.parameters !== undefined) updates.parameters = JSON.stringify(body.parameters);

  const rows = await db(TABLE).where({ id }).update(updates).returning('*');
  return (rows[0] as ReportConfig) ?? null;
}

export async function deleteById(db: Knex, id: string): Promise<void> {
  await db(TABLE).where({ id }).delete();
}
