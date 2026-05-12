import type { Knex } from 'knex';

export interface CampaignEvent {
  id: string;
  campaign_id: string;
  from_status: string | null;
  to_status: string;
  actor_id: string | null;
  comment: string | null;
  created_at: Date;
}

const TABLE = 'campaign_events';

export async function insertEvent(
  db: Knex,
  event: {
    campaign_id: string;
    from_status?: string | null;
    to_status: string;
    actor_id?: string | null;
    comment?: string | null;
  },
): Promise<CampaignEvent> {
  const [row] = await db(TABLE).insert(event).returning('*');
  return row as CampaignEvent;
}

export async function listByCampaignId(
  db: Knex,
  campaign_id: string,
): Promise<CampaignEvent[]> {
  const rows = await db(TABLE)
    .where({ campaign_id })
    .orderBy('created_at', 'asc');
  return rows as CampaignEvent[];
}
