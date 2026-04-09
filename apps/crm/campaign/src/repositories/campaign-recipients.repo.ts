import type { Knex } from 'knex';

export interface CampaignRecipient {
  campaign_id: string;
  lead_id: string;
  email: string;
  location_id: string;
  variant: string | null;
  sent_at: Date | null;
}

const TABLE = 'campaign_recipients';

export async function bulkInsert(
  db: Knex,
  rows: Omit<CampaignRecipient, 'sent_at'>[],
): Promise<void> {
  await db.batchInsert(TABLE, rows, 1000);
}

export async function bulkInsertFull(
  db: Knex,
  rows: CampaignRecipient[],
): Promise<void> {
  await db.batchInsert(TABLE, rows, 1000);
}

export async function findByCampaignAndVariant(
  db: Knex,
  campaignId: string,
  variant: string,
  limit: number,
  offset: number,
): Promise<CampaignRecipient[]> {
  const rows = await db(TABLE)
    .where({ campaign_id: campaignId, variant })
    .limit(limit)
    .offset(offset);
  return rows as CampaignRecipient[];
}

export async function updateSentAt(
  db: Knex,
  campaignId: string,
  variant: string,
  locationId: string,
  sentAt: Date,
): Promise<void> {
  await db(TABLE)
    .where({ campaign_id: campaignId, variant, location_id: locationId })
    .update({ sent_at: sentAt });
}
