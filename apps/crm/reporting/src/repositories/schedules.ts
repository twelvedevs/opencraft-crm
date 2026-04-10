import type { Knex } from 'knex';
import type { ScheduleBody } from '../schemas/schedule.js';

const TABLE = 'crm_reporting.report_schedules';

export interface ReportSchedule {
  id: string;
  report_config_id: string;
  frequency: string;
  day_of_week: number | null;
  day_of_month: number | null;
  hour_utc: number;
  recipient_emails: string[];
  format: string;
  active: boolean;
  created_by: string;
  created_at: Date;
}

export async function findById(db: Knex, id: string): Promise<ReportSchedule | null> {
  const row = await db(TABLE).where({ id }).first();
  return (row as ReportSchedule) ?? null;
}

export async function findByReportConfigId(
  db: Knex,
  reportConfigId: string,
): Promise<ReportSchedule[]> {
  return (await db(TABLE).where({ report_config_id: reportConfigId })) as ReportSchedule[];
}

export async function findAllActive(db: Knex): Promise<ReportSchedule[]> {
  return (await db(TABLE).where({ active: true })) as ReportSchedule[];
}

export async function create(
  db: Knex,
  body: ScheduleBody,
  createdBy: string,
): Promise<ReportSchedule> {
  const [row] = await db(TABLE)
    .insert({
      report_config_id: body.report_config_id,
      frequency: body.frequency,
      day_of_week: body.day_of_week ?? null,
      day_of_month: body.day_of_month ?? null,
      hour_utc: body.hour_utc,
      recipient_emails: body.recipient_emails,
      format: body.format ?? 'pdf',
      active: body.active ?? true,
      created_by: createdBy,
    })
    .returning('*');
  return row as ReportSchedule;
}

export async function update(
  db: Knex,
  id: string,
  body: Partial<ScheduleBody>,
): Promise<ReportSchedule | null> {
  const updates: Record<string, unknown> = {};
  if (body.frequency !== undefined) updates.frequency = body.frequency;
  if (body.day_of_week !== undefined) updates.day_of_week = body.day_of_week;
  if (body.day_of_month !== undefined) updates.day_of_month = body.day_of_month;
  if (body.hour_utc !== undefined) updates.hour_utc = body.hour_utc;
  if (body.recipient_emails !== undefined) updates.recipient_emails = body.recipient_emails;
  if (body.format !== undefined) updates.format = body.format;
  if (body.active !== undefined) updates.active = body.active;

  const rows = await db(TABLE).where({ id }).update(updates).returning('*');
  return (rows[0] as ReportSchedule) ?? null;
}

export async function setActive(db: Knex, id: string, active: boolean): Promise<void> {
  await db(TABLE).where({ id }).update({ active });
}

export async function deleteById(db: Knex, id: string): Promise<void> {
  await db(TABLE).where({ id }).delete();
}
