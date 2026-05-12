import type { Knex } from 'knex';

export interface CampaignSend {
  id: string;
  campaign_id: string;
  location_id: string;
  variant: string | null;
  subject_used: string;
  email_job_id: string | null;
  email_job_ref: string;
  status: string;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  started_at: Date | null;
  completed_at: Date | null;
}

const TABLE = 'campaign_sends';

export async function findByEmailJobId(
  db: Knex,
  emailJobId: string,
): Promise<CampaignSend | null> {
  const row = await db(TABLE).where({ email_job_id: emailJobId }).first();
  return (row as CampaignSend) ?? null;
}

export async function findByEmailJobRef(
  db: Knex,
  ref: string,
): Promise<CampaignSend | null> {
  const row = await db(TABLE).where({ email_job_ref: ref }).first();
  return (row as CampaignSend) ?? null;
}

export async function findAllByCampaignId(
  db: Knex,
  campaignId: string,
): Promise<CampaignSend[]> {
  const rows = await db(TABLE).where({ campaign_id: campaignId });
  return rows as CampaignSend[];
}

export async function countNonTerminalSends(
  db: Knex,
  campaignId: string,
): Promise<number> {
  const [{ count }] = await db(TABLE)
    .where({ campaign_id: campaignId })
    .whereNotIn('status', ['completed', 'completed_with_errors', 'failed', 'cancelled'])
    .count('* as count');
  return Number(count);
}

export async function insert(
  db: Knex,
  data: Omit<CampaignSend, 'id'>,
): Promise<CampaignSend> {
  const [row] = await db(TABLE).insert(data).returning('*');
  return row as CampaignSend;
}

export async function update(
  db: Knex,
  id: string,
  data: Partial<Omit<CampaignSend, 'id'>>,
): Promise<CampaignSend> {
  const [row] = await db(TABLE).where({ id }).update(data).returning('*');
  return row as CampaignSend;
}
