import type { Knex } from 'knex';
import { createLogger } from '@ortho/logger';
import { insertConversion } from '../repositories/campaign-conversions.repo.js';

const log = createLogger('lead-stage-changed-handler');

export interface LeadStageChangedPayload {
  lead_id: string;
  stage_to: string;
  pipeline: string;
  transitioned_at: string;
}

export async function handleLeadStageChanged(
  payload: LeadStageChangedPayload,
  db: Knex,
): Promise<void> {
  const occurredAt = new Date(payload.transitioned_at);

  // Step 1: find all campaigns this lead was sent to within the 7-day attribution window
  // Uses occurred_at as the anchor — NOT processing time
  const rows: { campaign_id: string }[] = await db('campaign_recipients')
    .select(db.raw('DISTINCT campaign_id'))
    .where({ lead_id: payload.lead_id })
    .whereNotNull('sent_at')
    .where('sent_at', '>', db.raw("?::timestamptz - interval '7 days'", [occurredAt.toISOString()]));

  if (rows.length === 0) {
    return;
  }

  // Step 2: insert conversion for each matching campaign
  for (const row of rows) {
    await insertConversion(db, {
      campaign_id: row.campaign_id,
      lead_id: payload.lead_id,
      stage_to: payload.stage_to,
      pipeline: payload.pipeline,
      converted_at: occurredAt,
    });
  }

  log.info(
    { lead_id: payload.lead_id, campaign_count: rows.length },
    'Conversion attribution recorded',
  );
}
