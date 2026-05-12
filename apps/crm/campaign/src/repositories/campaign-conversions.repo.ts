import type { Knex } from 'knex';

export interface CampaignConversion {
  id: string;
  campaign_id: string;
  lead_id: string;
  stage_to: string;
  pipeline: string;
  converted_at: Date;
}

const TABLE = 'campaign_conversions';

export async function insertConversion(
  db: Knex,
  data: Omit<CampaignConversion, 'id'>,
): Promise<void> {
  await db(TABLE)
    .insert(data)
    .onConflict(['campaign_id', 'lead_id'])
    .ignore();
}

export async function listByCampaignId(
  db: Knex,
  campaignId: string,
  opts: { limit: number; offset: number },
): Promise<{ conversions: CampaignConversion[]; total: number }> {
  const [rows, [{ count }]] = await Promise.all([
    db(TABLE)
      .where({ campaign_id: campaignId })
      .orderBy('converted_at', 'desc')
      .limit(opts.limit)
      .offset(opts.offset),
    db(TABLE)
      .where({ campaign_id: campaignId })
      .count('* as count'),
  ]);
  return {
    conversions: rows as CampaignConversion[],
    total: Number(count),
  };
}
