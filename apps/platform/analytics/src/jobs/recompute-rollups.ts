import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Pool, PoolClient } from 'pg';
import { env } from '../env.js';

const VALID_TABLES = new Set([
  'metrics_leads_daily',
  'metrics_pipeline_daily',
  'metrics_conversions_daily',
  'metrics_messages_daily',
  'metrics_ad_spend_daily',
  'metrics_campaigns_daily',
  'metrics_referrals_daily',
  'metrics_coordinators_daily',
]);

export interface RecomputeJobData {
  table: string;
  date_range: { from: string; to: string };
}

async function recomputeTable(
  client: PoolClient,
  table: string,
  from: string,
  to: string,
): Promise<number> {
  // Delete existing rollup rows for the date range before re-deriving from raw events
  await client.query(
    `DELETE FROM platform_analytics.${table} WHERE date >= $1::date AND date <= $2::date`,
    [from, to],
  );

  let rowCount = 0;

  switch (table) {
    case 'metrics_leads_daily': {
      const r = await client.query(
        `INSERT INTO platform_analytics.metrics_leads_daily (date, location_id, channel, count, archived)
         SELECT
           occurred_at::date                                   AS date,
           dimensions->>'location_id'                          AS location_id,
           dimensions->>'channel'                              AS channel,
           COUNT(*) FILTER (WHERE event_type = 'lead.created') AS count,
           COUNT(*) FILTER (WHERE event_type = 'lead.archived') AS archived
         FROM platform_analytics.analytics_events
         WHERE event_type IN ('lead.created', 'lead.archived')
           AND occurred_at::date BETWEEN $1::date AND $2::date
         GROUP BY occurred_at::date, dimensions->>'location_id', dimensions->>'channel'
         ON CONFLICT (date, location_id, channel) DO UPDATE SET
           count    = EXCLUDED.count,
           archived = EXCLUDED.archived`,
        [from, to],
      );
      rowCount = r.rowCount ?? 0;
      break;
    }

    case 'metrics_pipeline_daily': {
      const r = await client.query(
        `INSERT INTO platform_analytics.metrics_pipeline_daily (date, location_id, pipeline, stage, entries)
         SELECT
           occurred_at::date          AS date,
           dimensions->>'location_id' AS location_id,
           dimensions->>'pipeline'    AS pipeline,
           dimensions->>'stage'       AS stage,
           COUNT(*)                   AS entries
         FROM platform_analytics.analytics_events
         WHERE event_type = 'lead.stage_changed'
           AND occurred_at::date BETWEEN $1::date AND $2::date
         GROUP BY occurred_at::date, dimensions->>'location_id', dimensions->>'pipeline', dimensions->>'stage'
         ON CONFLICT (date, location_id, pipeline, stage) DO UPDATE SET
           entries = EXCLUDED.entries`,
        [from, to],
      );
      rowCount = r.rowCount ?? 0;
      break;
    }

    case 'metrics_conversions_daily': {
      // referral.converted uses channel='referral' (hardcoded in handler);
      // lead.converted uses channel from dimensions.
      const r = await client.query(
        `INSERT INTO platform_analytics.metrics_conversions_daily (date, location_id, channel, count)
         SELECT
           occurred_at::date AS date,
           dimensions->>'location_id' AS location_id,
           CASE event_type
             WHEN 'referral.converted' THEN 'referral'
             ELSE COALESCE(dimensions->>'channel', 'unknown')
           END AS channel,
           COUNT(*) AS count
         FROM platform_analytics.analytics_events
         WHERE event_type IN ('lead.converted', 'referral.converted')
           AND occurred_at::date BETWEEN $1::date AND $2::date
         GROUP BY
           occurred_at::date,
           dimensions->>'location_id',
           CASE event_type
             WHEN 'referral.converted' THEN 'referral'
             ELSE COALESCE(dimensions->>'channel', 'unknown')
           END
         ON CONFLICT (date, location_id, channel) DO UPDATE SET
           count = EXCLUDED.count`,
        [from, to],
      );
      rowCount = r.rowCount ?? 0;
      break;
    }

    case 'metrics_messages_daily': {
      const r = await client.query(
        `INSERT INTO platform_analytics.metrics_messages_daily (date, location_id, delivered, failed, opt_outs)
         SELECT
           occurred_at::date AS date,
           dimensions->>'location_id' AS location_id,
           COUNT(*) FILTER (WHERE event_type = 'message.delivered') AS delivered,
           COUNT(*) FILTER (WHERE event_type = 'message.failed')    AS failed,
           COUNT(*) FILTER (WHERE event_type = 'opt_out.received')  AS opt_outs
         FROM platform_analytics.analytics_events
         WHERE event_type IN ('message.delivered', 'message.failed', 'opt_out.received')
           AND occurred_at::date BETWEEN $1::date AND $2::date
         GROUP BY occurred_at::date, dimensions->>'location_id'
         ON CONFLICT (date, location_id) DO UPDATE SET
           delivered = EXCLUDED.delivered,
           failed    = EXCLUDED.failed,
           opt_outs  = EXCLUDED.opt_outs`,
        [from, to],
      );
      rowCount = r.rowCount ?? 0;
      break;
    }

    case 'metrics_ad_spend_daily': {
      // Ad spend date field = synced_date from properties (not occurred_at).
      // The DELETE above uses the `date` column which stores synced_date, so it is consistent.
      const r = await client.query(
        `INSERT INTO platform_analytics.metrics_ad_spend_daily
           (date, platform, location_id, campaign_id, campaign_name, impressions, clicks, spend)
         SELECT
           (properties->>'synced_date')::date        AS date,
           dimensions->>'platform'                   AS platform,
           dimensions->>'location_id'                AS location_id,
           rec->>'campaign_id'                        AS campaign_id,
           COALESCE(rec->>'campaign_name', '')        AS campaign_name,
           COALESCE((rec->>'impressions')::int, 0)   AS impressions,
           COALESCE((rec->>'clicks')::int, 0)        AS clicks,
           COALESCE((rec->>'spend')::numeric, 0)     AS spend
         FROM platform_analytics.analytics_events,
              jsonb_array_elements(properties->'records') AS rec
         WHERE event_type = 'ad_spend.synced'
           AND (properties->>'synced_date')::date BETWEEN $1::date AND $2::date
         ON CONFLICT (date, platform, location_id, campaign_id) DO UPDATE SET
           campaign_name = EXCLUDED.campaign_name,
           impressions   = EXCLUDED.impressions,
           clicks        = EXCLUDED.clicks,
           spend         = EXCLUDED.spend`,
        [from, to],
      );
      rowCount = r.rowCount ?? 0;
      break;
    }

    case 'metrics_campaigns_daily': {
      // campaign.delivered increments by recipient_count (bulk), not 1.
      const r = await client.query(
        `INSERT INTO platform_analytics.metrics_campaigns_daily
           (date, campaign_id, location_id, sent, delivered, opened, clicked)
         SELECT
           occurred_at::date AS date,
           dimensions->>'campaign_id' AS campaign_id,
           dimensions->>'location_id' AS location_id,
           COUNT(*) FILTER (WHERE event_type = 'campaign.sent') AS sent,
           COALESCE(SUM(
             CASE WHEN event_type = 'campaign.delivered'
               THEN COALESCE((properties->>'recipient_count')::int, 1)
               ELSE 0
             END
           ), 0) AS delivered,
           COUNT(*) FILTER (WHERE event_type = 'email.opened')  AS opened,
           COUNT(*) FILTER (WHERE event_type = 'email.clicked') AS clicked
         FROM platform_analytics.analytics_events
         WHERE event_type IN ('campaign.sent', 'campaign.delivered', 'email.opened', 'email.clicked')
           AND occurred_at::date BETWEEN $1::date AND $2::date
         GROUP BY occurred_at::date, dimensions->>'campaign_id', dimensions->>'location_id'
         ON CONFLICT (date, campaign_id, location_id) DO UPDATE SET
           sent      = EXCLUDED.sent,
           delivered = EXCLUDED.delivered,
           opened    = EXCLUDED.opened,
           clicked   = EXCLUDED.clicked`,
        [from, to],
      );
      rowCount = r.rowCount ?? 0;
      break;
    }

    case 'metrics_referrals_daily': {
      const r = await client.query(
        `INSERT INTO platform_analytics.metrics_referrals_daily (date, location_id, count)
         SELECT
           occurred_at::date          AS date,
           dimensions->>'location_id' AS location_id,
           COUNT(*)                   AS count
         FROM platform_analytics.analytics_events
         WHERE event_type = 'referral.converted'
           AND occurred_at::date BETWEEN $1::date AND $2::date
         GROUP BY occurred_at::date, dimensions->>'location_id'
         ON CONFLICT (date, location_id) DO UPDATE SET
           count = EXCLUDED.count`,
        [from, to],
      );
      rowCount = r.rowCount ?? 0;
      break;
    }

    case 'metrics_coordinators_daily': {
      // coordinator_id comes from properties.triggered_by (not stored in dimensions).
      // response_time_sum/count only incremented when response_time_seconds is present.
      const r = await client.query(
        `INSERT INTO platform_analytics.metrics_coordinators_daily
           (date, location_id, coordinator_id,
            response_time_sum, response_time_count,
            time_in_stage_sum, time_in_stage_count)
         SELECT
           occurred_at::date                    AS date,
           dimensions->>'location_id'           AS location_id,
           properties->>'triggered_by'          AS coordinator_id,
           COALESCE(SUM(
             CASE WHEN properties->>'response_time_seconds' IS NOT NULL
               THEN (properties->>'response_time_seconds')::int
               ELSE 0
             END
           ), 0) AS response_time_sum,
           COUNT(*) FILTER (WHERE properties->>'response_time_seconds' IS NOT NULL) AS response_time_count,
           COALESCE(SUM(COALESCE((properties->>'time_in_stage_seconds')::int, 0)), 0) AS time_in_stage_sum,
           COUNT(*) AS time_in_stage_count
         FROM platform_analytics.analytics_events
         WHERE event_type = 'lead.stage_changed'
           AND properties->>'triggered_by' IS NOT NULL
           AND occurred_at::date BETWEEN $1::date AND $2::date
         GROUP BY occurred_at::date, dimensions->>'location_id', properties->>'triggered_by'
         ON CONFLICT (date, location_id, coordinator_id) DO UPDATE SET
           response_time_sum   = EXCLUDED.response_time_sum,
           response_time_count = EXCLUDED.response_time_count,
           time_in_stage_sum   = EXCLUDED.time_in_stage_sum,
           time_in_stage_count = EXCLUDED.time_in_stage_count`,
        [from, to],
      );
      rowCount = r.rowCount ?? 0;
      break;
    }

    default:
      throw new Error(`Unsupported table: ${table}`);
  }

  return rowCount;
}

export function createRecomputeRollupsWorker(queue: Queue, pool: Pool): Worker {
  // Worker uses a dedicated connection — BullMQ Workers require blocking Redis commands
  const connection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  return new Worker<RecomputeJobData, { rows_written: number }>(
    queue.name,
    async (job) => {
      const { table, date_range } = job.data;

      if (!VALID_TABLES.has(table)) {
        throw new Error(`Invalid table: ${table}`);
      }

      await job.updateProgress(10);

      const client = await pool.connect();
      let rows_written = 0;
      try {
        await client.query('BEGIN');
        rows_written = await recomputeTable(client, table, date_range.from, date_range.to);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      await job.updateProgress(100);

      return { rows_written };
    },
    { connection },
  );
}
