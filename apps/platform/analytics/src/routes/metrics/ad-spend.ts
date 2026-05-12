import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import {
  SharedQuerySchema,
  parsePeriod,
  toArray,
  dateExpr,
  paginateMeta,
} from './shared.js';

const AdSpendQuerySchema = Type.Intersect([
  SharedQuerySchema,
  Type.Object({
    platform: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
    campaign_id: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
  }),
]);

export async function adSpendRoutes(app: FastifyInstance, options: { pool: Pool }): Promise<void> {
  // GET /analytics/metrics/ad-spend — ad spend aggregated by platform/campaign
  app.get('/analytics/metrics/ad-spend', {
    schema: { querystring: AdSpendQuerySchema, tags: ['Metrics'], summary: 'Get ad spend metrics' } as object,
  }, async (request, reply) => {
    const query = request.query as {
      period: string;
      granularity?: string;
      location_id?: string | string[];
      platform?: string | string[];
      campaign_id?: string | string[];
      page?: number;
      page_size?: number;
    };

    const range = parsePeriod(query.period);
    if (!range) {
      return reply.status(400).send({ error: 'Invalid period. Use YYYY-MM or YYYY-MM-DD/YYYY-MM-DD' });
    }

    const granularity = (query.granularity ?? 'daily') as 'daily' | 'monthly' | 'total';
    const locationIds = toArray(query.location_id);
    const platforms = toArray(query.platform);
    const campaignIds = toArray(query.campaign_id);
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 1000;
    const offset = (page - 1) * pageSize;

    const params: unknown[] = [range.start, range.end];
    const whereClauses = ['date >= $1', 'date <= $2'];

    if (locationIds.length > 0) {
      params.push(locationIds);
      whereClauses.push(`location_id = ANY($${params.length})`);
    }
    if (platforms.length > 0) {
      params.push(platforms);
      whereClauses.push(`platform = ANY($${params.length})`);
    }
    if (campaignIds.length > 0) {
      params.push(campaignIds);
      whereClauses.push(`campaign_id = ANY($${params.length})`);
    }

    const where = whereClauses.join(' AND ');
    const dExpr = dateExpr(granularity);

    let selectCols: string;
    let groupBy: string;
    if (dExpr) {
      selectCols = `${dExpr} AS date, platform, location_id, campaign_id, SUM(impressions)::int AS impressions, SUM(clicks)::int AS clicks, SUM(spend)::numeric AS spend`;
      groupBy = `GROUP BY ${dExpr}, platform, location_id, campaign_id`;
    } else {
      selectCols = `platform, location_id, campaign_id, SUM(impressions)::int AS impressions, SUM(clicks)::int AS clicks, SUM(spend)::numeric AS spend`;
      groupBy = `GROUP BY platform, location_id, campaign_id`;
    }

    const countParams = [...params];
    const countSql = `SELECT COUNT(*) FROM (SELECT 1 FROM platform_analytics.metrics_ad_spend_daily WHERE ${where} ${groupBy}) sub`;
    const countResult = await options.pool.query(countSql, countParams);
    const total = parseInt(countResult.rows[0].count, 10);

    params.push(pageSize, offset);
    const dataSql = `SELECT ${selectCols} FROM platform_analytics.metrics_ad_spend_daily WHERE ${where} ${groupBy} ORDER BY ${dExpr ? `${dExpr}, ` : ''}platform, location_id, campaign_id LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const dataResult = await options.pool.query(dataSql, params);

    return reply.status(200).send({
      period: query.period,
      granularity,
      data: dataResult.rows,
      meta: paginateMeta(total, page, pageSize),
    });
  });

  // GET /analytics/metrics/ad-spend/campaigns — always GROUP BY campaign_id
  // (enforces the constraint that campaign_name is a display hint only — never group by it)
  app.get('/analytics/metrics/ad-spend/campaigns', {
    schema: { querystring: AdSpendQuerySchema, tags: ['Metrics'], summary: 'Get ad spend by campaign' } as object,
  }, async (request, reply) => {
    const query = request.query as {
      period: string;
      granularity?: string;
      location_id?: string | string[];
      platform?: string | string[];
      campaign_id?: string | string[];
      page?: number;
      page_size?: number;
    };

    const range = parsePeriod(query.period);
    if (!range) {
      return reply.status(400).send({ error: 'Invalid period. Use YYYY-MM or YYYY-MM-DD/YYYY-MM-DD' });
    }

    const granularity = (query.granularity ?? 'daily') as 'daily' | 'monthly' | 'total';
    const locationIds = toArray(query.location_id);
    const platforms = toArray(query.platform);
    const campaignIds = toArray(query.campaign_id);
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 1000;
    const offset = (page - 1) * pageSize;

    const params: unknown[] = [range.start, range.end];
    const whereClauses = ['date >= $1', 'date <= $2'];

    if (locationIds.length > 0) {
      params.push(locationIds);
      whereClauses.push(`location_id = ANY($${params.length})`);
    }
    if (platforms.length > 0) {
      params.push(platforms);
      whereClauses.push(`platform = ANY($${params.length})`);
    }
    if (campaignIds.length > 0) {
      params.push(campaignIds);
      whereClauses.push(`campaign_id = ANY($${params.length})`);
    }

    const where = whereClauses.join(' AND ');
    const dExpr = dateExpr(granularity);

    // Always GROUP BY campaign_id — campaign_name is a display hint only
    let selectCols: string;
    let groupBy: string;
    if (dExpr) {
      selectCols = `${dExpr} AS date, platform, location_id, campaign_id, SUM(impressions)::int AS impressions, SUM(clicks)::int AS clicks, SUM(spend)::numeric AS spend`;
      groupBy = `GROUP BY ${dExpr}, platform, location_id, campaign_id`;
    } else {
      selectCols = `platform, location_id, campaign_id, SUM(impressions)::int AS impressions, SUM(clicks)::int AS clicks, SUM(spend)::numeric AS spend`;
      groupBy = `GROUP BY platform, location_id, campaign_id`;
    }

    const countParams = [...params];
    const countSql = `SELECT COUNT(*) FROM (SELECT 1 FROM platform_analytics.metrics_ad_spend_daily WHERE ${where} ${groupBy}) sub`;
    const countResult = await options.pool.query(countSql, countParams);
    const total = parseInt(countResult.rows[0].count, 10);

    params.push(pageSize, offset);
    const dataSql = `SELECT ${selectCols} FROM platform_analytics.metrics_ad_spend_daily WHERE ${where} ${groupBy} ORDER BY ${dExpr ? `${dExpr}, ` : ''}platform, location_id, campaign_id LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const dataResult = await options.pool.query(dataSql, params);

    return reply.status(200).send({
      period: query.period,
      granularity,
      data: dataResult.rows,
      meta: paginateMeta(total, page, pageSize),
    });
  });
}
