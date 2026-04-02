import type { PoolClient } from 'pg';

export interface UpsertLeadDailyParams {
  date: string; // YYYY-MM-DD
  location_id: string;
  channel: string;
  count_delta?: number;
  archived_delta?: number;
}

export async function upsertLeadDaily(
  client: PoolClient,
  params: UpsertLeadDailyParams,
): Promise<void> {
  await client.query(
    `INSERT INTO platform_analytics.metrics_leads_daily (date, location_id, channel, count, archived)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (date, location_id, channel) DO UPDATE SET
       count    = metrics_leads_daily.count    + EXCLUDED.count,
       archived = metrics_leads_daily.archived + EXCLUDED.archived`,
    [
      params.date,
      params.location_id,
      params.channel,
      params.count_delta ?? 0,
      params.archived_delta ?? 0,
    ],
  );
}

export interface UpsertPipelineDailyParams {
  date: string;
  location_id: string;
  pipeline: string;
  stage: string;
  entries_delta?: number;
}

export async function upsertPipelineDaily(
  client: PoolClient,
  params: UpsertPipelineDailyParams,
): Promise<void> {
  await client.query(
    `INSERT INTO platform_analytics.metrics_pipeline_daily (date, location_id, pipeline, stage, entries)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (date, location_id, pipeline, stage) DO UPDATE SET
       entries = metrics_pipeline_daily.entries + EXCLUDED.entries`,
    [
      params.date,
      params.location_id,
      params.pipeline,
      params.stage,
      params.entries_delta ?? 1,
    ],
  );
}

export interface UpsertConversionDailyParams {
  date: string;
  location_id: string;
  channel: string;
  count_delta?: number;
}

export async function upsertConversionDaily(
  client: PoolClient,
  params: UpsertConversionDailyParams,
): Promise<void> {
  await client.query(
    `INSERT INTO platform_analytics.metrics_conversions_daily (date, location_id, channel, count)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (date, location_id, channel) DO UPDATE SET
       count = metrics_conversions_daily.count + EXCLUDED.count`,
    [params.date, params.location_id, params.channel, params.count_delta ?? 1],
  );
}

export interface UpsertMessageDailyParams {
  date: string;
  location_id: string;
  delivered_delta?: number;
  failed_delta?: number;
  opt_outs_delta?: number;
}

export async function upsertMessageDaily(
  client: PoolClient,
  params: UpsertMessageDailyParams,
): Promise<void> {
  await client.query(
    `INSERT INTO platform_analytics.metrics_messages_daily (date, location_id, delivered, failed, opt_outs)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (date, location_id) DO UPDATE SET
       delivered = metrics_messages_daily.delivered + EXCLUDED.delivered,
       failed    = metrics_messages_daily.failed    + EXCLUDED.failed,
       opt_outs  = metrics_messages_daily.opt_outs  + EXCLUDED.opt_outs`,
    [
      params.date,
      params.location_id,
      params.delivered_delta ?? 0,
      params.failed_delta ?? 0,
      params.opt_outs_delta ?? 0,
    ],
  );
}

export interface UpsertAdSpendDailyParams {
  date: string;
  platform: string;
  location_id: string;
  campaign_id: string;
  campaign_name: string;
  impressions: number;
  clicks: number;
  spend: number;
}

// Ad spend upsert overwrites the full row rather than incrementing — this allows
// Integration Hub to re-publish corrected figures with the same campaign_id.
export async function upsertAdSpendDaily(
  client: PoolClient,
  params: UpsertAdSpendDailyParams,
): Promise<void> {
  await client.query(
    `INSERT INTO platform_analytics.metrics_ad_spend_daily
       (date, platform, location_id, campaign_id, campaign_name, impressions, clicks, spend)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (date, platform, location_id, campaign_id) DO UPDATE SET
       campaign_name = EXCLUDED.campaign_name,
       impressions   = EXCLUDED.impressions,
       clicks        = EXCLUDED.clicks,
       spend         = EXCLUDED.spend`,
    [
      params.date,
      params.platform,
      params.location_id,
      params.campaign_id,
      params.campaign_name,
      params.impressions,
      params.clicks,
      params.spend,
    ],
  );
}

export interface UpsertCampaignDailyParams {
  date: string;
  campaign_id: string;
  location_id: string;
  sent_delta?: number;
  delivered_delta?: number;
  opened_delta?: number;
  clicked_delta?: number;
}

export async function upsertCampaignDaily(
  client: PoolClient,
  params: UpsertCampaignDailyParams,
): Promise<void> {
  await client.query(
    `INSERT INTO platform_analytics.metrics_campaigns_daily
       (date, campaign_id, location_id, sent, delivered, opened, clicked)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (date, campaign_id, location_id) DO UPDATE SET
       sent      = metrics_campaigns_daily.sent      + EXCLUDED.sent,
       delivered = metrics_campaigns_daily.delivered + EXCLUDED.delivered,
       opened    = metrics_campaigns_daily.opened    + EXCLUDED.opened,
       clicked   = metrics_campaigns_daily.clicked   + EXCLUDED.clicked`,
    [
      params.date,
      params.campaign_id,
      params.location_id,
      params.sent_delta ?? 0,
      params.delivered_delta ?? 0,
      params.opened_delta ?? 0,
      params.clicked_delta ?? 0,
    ],
  );
}

export interface UpsertReferralDailyParams {
  date: string;
  location_id: string;
  count_delta?: number;
}

export async function upsertReferralDaily(
  client: PoolClient,
  params: UpsertReferralDailyParams,
): Promise<void> {
  await client.query(
    `INSERT INTO platform_analytics.metrics_referrals_daily (date, location_id, count)
     VALUES ($1, $2, $3)
     ON CONFLICT (date, location_id) DO UPDATE SET
       count = metrics_referrals_daily.count + EXCLUDED.count`,
    [params.date, params.location_id, params.count_delta ?? 1],
  );
}

export interface UpsertCoordinatorDailyParams {
  date: string;
  location_id: string;
  coordinator_id: string;
  response_time_sum_delta?: number;
  response_time_count_delta?: number;
  time_in_stage_sum_delta?: number;
  time_in_stage_count_delta?: number;
}

export async function upsertCoordinatorDaily(
  client: PoolClient,
  params: UpsertCoordinatorDailyParams,
): Promise<void> {
  await client.query(
    `INSERT INTO platform_analytics.metrics_coordinators_daily
       (date, location_id, coordinator_id,
        response_time_sum, response_time_count,
        time_in_stage_sum, time_in_stage_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (date, location_id, coordinator_id) DO UPDATE SET
       response_time_sum   = metrics_coordinators_daily.response_time_sum   + EXCLUDED.response_time_sum,
       response_time_count = metrics_coordinators_daily.response_time_count + EXCLUDED.response_time_count,
       time_in_stage_sum   = metrics_coordinators_daily.time_in_stage_sum   + EXCLUDED.time_in_stage_sum,
       time_in_stage_count = metrics_coordinators_daily.time_in_stage_count + EXCLUDED.time_in_stage_count`,
    [
      params.date,
      params.location_id,
      params.coordinator_id,
      params.response_time_sum_delta ?? 0,
      params.response_time_count_delta ?? 0,
      params.time_in_stage_sum_delta ?? 0,
      params.time_in_stage_count_delta ?? 0,
    ],
  );
}
