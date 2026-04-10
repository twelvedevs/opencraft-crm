import type { Knex } from 'knex';

const TABLE = 'crm_reporting.report_runs';

export interface ReportRun {
  id: string;
  report_config_id: string;
  report_schedule_id: string | null;
  triggered_by: string;
  format: string;
  status: string;
  media_file_id: string | null;
  error_message: string | null;
  started_at: Date;
  completed_at: Date | null;
  recipient_emails: string[] | null;
}

export interface CreateRunData {
  report_config_id: string;
  report_schedule_id?: string;
  triggered_by: string;
  format: string;
  status: string;
  recipient_emails?: string[];
}

export async function findById(db: Knex, id: string): Promise<ReportRun | null> {
  const row = await db(TABLE).where({ id }).first();
  return (row as ReportRun) ?? null;
}

export async function findByConfigId(
  db: Knex,
  configId: string,
  limit = 50,
): Promise<ReportRun[]> {
  return (await db(TABLE)
    .where({ report_config_id: configId })
    .orderBy('started_at', 'desc')
    .limit(limit)) as ReportRun[];
}

export async function create(db: Knex, data: CreateRunData): Promise<ReportRun> {
  const [row] = await db(TABLE)
    .insert({
      report_config_id: data.report_config_id,
      report_schedule_id: data.report_schedule_id ?? null,
      triggered_by: data.triggered_by,
      format: data.format,
      status: data.status,
      recipient_emails: data.recipient_emails ?? null,
    })
    .returning('*');
  return row as ReportRun;
}

export async function updateStatus(
  db: Knex,
  id: string,
  status: string,
  opts?: {
    media_file_id?: string;
    error_message?: string;
    completed_at?: Date | string;
  },
): Promise<void> {
  await db(TABLE)
    .where({ id })
    .update({
      status,
      ...(opts?.media_file_id !== undefined && { media_file_id: opts.media_file_id }),
      ...(opts?.error_message !== undefined && { error_message: opts.error_message }),
      ...(opts?.completed_at !== undefined && { completed_at: opts.completed_at }),
    });
}
