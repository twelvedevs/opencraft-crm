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

const CoordinatorsQuerySchema = Type.Intersect([
  SharedQuerySchema,
  Type.Object({
    coordinator_id: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
  }),
]);

export async function coordinatorsRoutes(app: FastifyInstance, options: { pool: Pool }): Promise<void> {
  app.get('/analytics/metrics/coordinators', {
    schema: { querystring: CoordinatorsQuerySchema },
  }, async (request, reply) => {
    const query = request.query as {
      period: string;
      granularity?: string;
      location_id?: string | string[];
      coordinator_id?: string | string[];
      page?: number;
      page_size?: number;
    };

    const range = parsePeriod(query.period);
    if (!range) {
      return reply.status(400).send({ error: 'Invalid period. Use YYYY-MM or YYYY-MM-DD/YYYY-MM-DD' });
    }

    const granularity = (query.granularity ?? 'daily') as 'daily' | 'monthly' | 'total';
    const locationIds = toArray(query.location_id);
    const coordinatorIds = toArray(query.coordinator_id);
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 1000;
    const offset = (page - 1) * pageSize;

    const params: unknown[] = [range.start, range.end];
    const whereClauses = ['date >= $1', 'date <= $2'];

    if (locationIds.length > 0) {
      params.push(locationIds);
      whereClauses.push(`location_id = ANY($${params.length})`);
    }
    if (coordinatorIds.length > 0) {
      params.push(coordinatorIds);
      whereClauses.push(`coordinator_id = ANY($${params.length})`);
    }

    const where = whereClauses.join(' AND ');
    const dExpr = dateExpr(granularity);

    // Return raw sums — Reporting Service computes means (response_time_sum/count, time_in_stage_sum/count)
    let selectCols: string;
    let groupBy: string;
    if (dExpr) {
      selectCols = `${dExpr} AS date, location_id, coordinator_id, SUM(response_time_sum)::int AS response_time_sum, SUM(response_time_count)::int AS response_time_count, SUM(time_in_stage_sum)::int AS time_in_stage_sum, SUM(time_in_stage_count)::int AS time_in_stage_count`;
      groupBy = `GROUP BY ${dExpr}, location_id, coordinator_id`;
    } else {
      selectCols = `location_id, coordinator_id, SUM(response_time_sum)::int AS response_time_sum, SUM(response_time_count)::int AS response_time_count, SUM(time_in_stage_sum)::int AS time_in_stage_sum, SUM(time_in_stage_count)::int AS time_in_stage_count`;
      groupBy = `GROUP BY location_id, coordinator_id`;
    }

    const countParams = [...params];
    const countSql = `SELECT COUNT(*) FROM (SELECT 1 FROM platform_analytics.metrics_coordinators_daily WHERE ${where} ${groupBy}) sub`;
    const countResult = await options.pool.query(countSql, countParams);
    const total = parseInt(countResult.rows[0].count, 10);

    params.push(pageSize, offset);
    const dataSql = `SELECT ${selectCols} FROM platform_analytics.metrics_coordinators_daily WHERE ${where} ${groupBy} ORDER BY ${dExpr ? `${dExpr}, ` : ''}location_id, coordinator_id LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const dataResult = await options.pool.query(dataSql, params);

    return reply.status(200).send({
      period: query.period,
      granularity,
      data: dataResult.rows,
      meta: paginateMeta(total, page, pageSize),
    });
  });
}
