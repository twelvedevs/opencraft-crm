import { createHash } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { buildQuery } from '../services/query-builder.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FilterSchema = Type.Object({
  field: Type.String({ minLength: 1 }),
  value: Type.Union([
    Type.String(),
    Type.Array(Type.String()),
  ]),
});

const QueryBodySchema = Type.Object({
  event_type: Type.String({ minLength: 1 }),
  aggregate: Type.Union([
    Type.Literal('count'),
    Type.Literal('sum'),
    Type.Literal('avg'),
  ]),
  aggregate_field: Type.Optional(Type.String()),
  filters: Type.Optional(Type.Array(FilterSchema)),
  group_by: Type.Optional(Type.Array(Type.String())),
  granularity: Type.Optional(Type.Union([
    Type.Literal('daily'),
    Type.Literal('monthly'),
    Type.Literal('total'),
  ])),
  period: Type.Object({
    from: Type.String({ minLength: 1 }),
    to: Type.String({ minLength: 1 }),
  }),
});

// ---------------------------------------------------------------------------
// Rate limit key generator
// ---------------------------------------------------------------------------

const RATE_LIMIT_CONFIG = {
  keyGenerator: (req: FastifyRequest): string => {
    const auth = (req.headers['authorization'] as string | undefined) ?? '';
    if (auth.startsWith('ak_')) {
      return `apikey:${createHash('sha256').update(auth).digest('hex')}`;
    }
    // JWT: extract sub from payload for per-user keying
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    if (token) {
      try {
        const parts = token.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
          if (payload.sub) return `jwt:${String(payload.sub)}`;
        }
      } catch {
        // fall through
      }
    }
    // Unauthenticated / unrecognised — key by hash of raw header
    return `anon:${createHash('sha256').update(auth).digest('hex')}`;
  },
  max: (_req: FastifyRequest, key: string): number => {
    // API key callers get 100 req/min; JWT / anonymous get 10 req/min
    return key.startsWith('apikey:') ? 100 : 10;
  },
  timeWindow: '1 minute',
};

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const MAX_ROWS = 10_000;

export async function queryRoutes(
  app: FastifyInstance,
  options: { pool: Pool },
): Promise<void> {
  app.post('/analytics/query', {
    schema: { body: QueryBodySchema, tags: ['Query'], summary: 'Execute ad-hoc analytics query' } as object,
    config: { rateLimit: RATE_LIMIT_CONFIG },
  }, async (request, reply) => {
    const body = request.body as {
      event_type: string;
      aggregate: 'count' | 'sum' | 'avg';
      aggregate_field?: string;
      filters?: Array<{ field: string; value: string | string[] }>;
      group_by?: string[];
      granularity?: 'daily' | 'monthly' | 'total';
      period: { from: string; to: string };
    };

    // sum/avg require an aggregate_field
    if ((body.aggregate === 'sum' || body.aggregate === 'avg') && !body.aggregate_field) {
      return reply.status(400).send({
        error: 'aggregate_field is required when aggregate is "sum" or "avg"',
      });
    }

    // Prepend event_type as the first filter
    const filters = [
      { field: 'event_type', value: body.event_type },
      ...(body.filters ?? []),
    ];

    let sql: string;
    let bindings: unknown[];

    try {
      ({ sql, bindings } = buildQuery({
        aggregate: body.aggregate,
        aggregate_field: body.aggregate_field,
        filters,
        group_by: body.group_by,
        granularity: body.granularity ?? 'total',
        period: body.period,
      }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Invalid query parameters';
      return reply.status(400).send({ error: message });
    }

    // Fetch up to MAX_ROWS + 1 to detect truncation
    const limitedSql = `${sql} LIMIT ${MAX_ROWS + 1}`;
    const result = await options.pool.query(limitedSql, bindings);

    const truncated = result.rows.length > MAX_ROWS;
    const rows = truncated ? result.rows.slice(0, MAX_ROWS) : result.rows;

    return reply.status(200).send({
      rows,
      total: rows.length,
      truncated,
    });
  });
}
