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

const PipelineQuerySchema = Type.Intersect([
  SharedQuerySchema,
  Type.Object({
    pipeline: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
    stage: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
  }),
]);

export async function pipelineRoutes(app: FastifyInstance, options: { pool: Pool }): Promise<void> {
  app.get('/analytics/metrics/pipeline', {
    schema: { querystring: PipelineQuerySchema, tags: ['Metrics'], summary: 'Get pipeline funnel metrics' } as object,
  }, async (request, reply) => {
    const query = request.query as {
      period: string;
      granularity?: string;
      location_id?: string | string[];
      pipeline?: string | string[];
      stage?: string | string[];
      page?: number;
      page_size?: number;
    };

    const range = parsePeriod(query.period);
    if (!range) {
      return reply.status(400).send({ error: 'Invalid period. Use YYYY-MM or YYYY-MM-DD/YYYY-MM-DD' });
    }

    const granularity = (query.granularity ?? 'daily') as 'daily' | 'monthly' | 'total';
    const locationIds = toArray(query.location_id);
    const pipelines = toArray(query.pipeline);
    const stages = toArray(query.stage);
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 1000;
    const offset = (page - 1) * pageSize;

    const params: unknown[] = [range.start, range.end];
    const whereClauses = ['date >= $1', 'date <= $2'];

    if (locationIds.length > 0) {
      params.push(locationIds);
      whereClauses.push(`location_id = ANY($${params.length})`);
    }
    if (pipelines.length > 0) {
      params.push(pipelines);
      whereClauses.push(`pipeline = ANY($${params.length})`);
    }
    if (stages.length > 0) {
      params.push(stages);
      whereClauses.push(`stage = ANY($${params.length})`);
    }

    const where = whereClauses.join(' AND ');
    const dExpr = dateExpr(granularity);

    let selectCols: string;
    let groupBy: string;
    if (dExpr) {
      selectCols = `${dExpr} AS date, location_id, pipeline, stage, SUM(entries)::int AS entries`;
      groupBy = `GROUP BY ${dExpr}, location_id, pipeline, stage`;
    } else {
      selectCols = `location_id, pipeline, stage, SUM(entries)::int AS entries`;
      groupBy = `GROUP BY location_id, pipeline, stage`;
    }

    const countParams = [...params];
    const countSql = `SELECT COUNT(*) FROM (SELECT 1 FROM platform_analytics.metrics_pipeline_daily WHERE ${where} ${groupBy}) sub`;
    const countResult = await options.pool.query(countSql, countParams);
    const total = parseInt(countResult.rows[0].count, 10);

    params.push(pageSize, offset);
    const dataSql = `SELECT ${selectCols} FROM platform_analytics.metrics_pipeline_daily WHERE ${where} ${groupBy} ORDER BY ${dExpr ? `${dExpr}, ` : ''}location_id, pipeline, stage LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const dataResult = await options.pool.query(dataSql, params);

    return reply.status(200).send({
      period: query.period,
      granularity,
      data: dataResult.rows,
      meta: paginateMeta(total, page, pageSize),
    });
  });
}
