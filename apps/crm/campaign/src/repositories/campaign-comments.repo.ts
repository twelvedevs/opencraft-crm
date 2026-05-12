import type { Knex } from 'knex';

export interface CampaignComment {
  id: string;
  campaign_id: string;
  author_id: string;
  body: string;
  created_at: Date;
}

const TABLE = 'campaign_comments';

export async function insertComment(
  db: Knex,
  comment: {
    campaign_id: string;
    author_id: string;
    body: string;
  },
): Promise<CampaignComment> {
  const [row] = await db(TABLE).insert(comment).returning('*');
  return row as CampaignComment;
}

export async function listByCampaignId(
  db: Knex,
  campaign_id: string,
  opts: { limit: number; offset: number },
): Promise<{ comments: CampaignComment[]; total: number }> {
  const [{ count }] = await db(TABLE)
    .where({ campaign_id })
    .count('* as count');
  const total = Number(count);

  const rows = await db(TABLE)
    .where({ campaign_id })
    .orderBy('created_at', 'asc')
    .limit(opts.limit)
    .offset(opts.offset);

  return { comments: rows as CampaignComment[], total };
}
