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

const ConversionsQuerySchema = Type.Intersect([
  SharedQuerySchema,
  Type.Object({
    channel: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
  }),
]);

export async function conversionsRoutes(
  app: FastifyInstance,
  options: { pool: Pool },
): Promise<void> {
  app.get('/analytics/metrics/conversions', {
    schema: { querystring: ConversionsQuerySchema, tags: ['Metrics'], summary: 'Get conversion metrics' } as object,
  }, async (request, reply) => {
    const query = request.query as {
      period: string;
      granularity?: string;
      location_id?: string | string[];
      channel?: string | string[];
      page?: number;
      page_size?: number;
    };

    const range = parsePeriod(query.period);
    if (!range) {
      return reply.status(400).send({ error: 'Invalid period. Use YYYY-MM or YYYY-MM-DD/YYYY-MM-DD' });
    }

    const granularity = (query.granularity ?? 'daily') as 'daily' | 'monthly' | 'total';
    const locationIds = toArray(query.location_id);
    const channels = toArray(query.channel);
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 1000;
    const offset = (page - 1) * pageSize;

    const params: unknown[] = [range.start, range.end];
    const whereClauses = ['date >= $1', 'date <= $2'];

    if (locationIds.length > 0) {
      params.push(locationIds);
      whereClauses.push(`location_id = ANY($${params.length})`);
    }
    if (channels.length > 0) {
      params.push(channels);
      whereClauses.push(`channel = ANY($${params.length})`);
    }

    const where = whereClauses.join(' AND ');
    const dExpr = dateExpr(granularity);

    let selectCols: string;
    let groupBy: string;
    if (dExpr) {
      selectCols = `${dExpr} AS date, location_id, channel, SUM(count)::int AS count`;
      groupBy = `GROUP BY ${dExpr}, location_id, channel`;
    } else {
      selectCols = `location_id, channel, SUM(count)::int AS count`;
      groupBy = `GROUP BY location_id, channel`;
    }

    const countParams = [...params];
    const countSql = `SELECT COUNT(*) FROM (SELECT 1 FROM platform_analytics.metrics_conversions_daily WHERE ${where} ${groupBy}) sub`;
    const countResult = await options.pool.query(countSql, countParams);
    const total = parseInt(countResult.rows[0].count, 10);

    params.push(pageSize, offset);
    const dataSql = `SELECT ${selectCols} FROM platform_analytics.metrics_conversions_daily WHERE ${where} ${groupBy} ORDER BY ${dExpr ? `${dExpr}, ` : ''}location_id, channel LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const dataResult = await options.pool.query(dataSql, params);

    return reply.status(200).send({
      period: query.period,
      granularity,
      data: dataResult.rows,
      meta: paginateMeta(total, page, pageSize),
    });
  });
}
