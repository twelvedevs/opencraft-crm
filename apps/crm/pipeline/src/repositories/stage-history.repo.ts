import type { Knex } from 'knex';

export interface StageHistory {
  id: string;
  membership_id: string;
  lead_id: string;
  pipeline: string;
  stage_from: string | null;
  stage_to: string;
  override: boolean;
  triggered_by: string | null;
  reason: string | null;
  transitioned_at: Date;
}

const TABLE = 'pipeline_stage_history';

export async function insertHistory(
  db: Knex,
  data: {
    membership_id: string;
    lead_id: string;
    pipeline: string;
    stage_from: string | null;
    stage_to: string;
    override: boolean;
    triggered_by?: string | null;
    reason?: string | null;
  },
): Promise<StageHistory> {
  const [row] = await db(TABLE)
    .insert({
      membership_id: data.membership_id,
      lead_id: data.lead_id,
      pipeline: data.pipeline,
      stage_from: data.stage_from,
      stage_to: data.stage_to,
      override: data.override,
      triggered_by: data.triggered_by ?? null,
      reason: data.reason ?? null,
    })
    .returning('*');
  return row as StageHistory;
}

export async function findByMembershipId(
  db: Knex,
  membershipId: string,
): Promise<StageHistory[]> {
  const rows = await db(TABLE)
    .where({ membership_id: membershipId })
    .orderBy('transitioned_at', 'asc');
  return rows as StageHistory[];
}
