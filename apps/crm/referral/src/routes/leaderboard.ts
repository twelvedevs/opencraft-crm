import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { Type } from '@sinclair/typebox';
import { requirePermission } from '@ortho/auth-middleware';

const LeaderboardQuery = Type.Object({
  location_id: Type.String(),
  referrer_type: Type.Optional(Type.String()),
  period_start: Type.Optional(Type.String()),
  period_end: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
});

const readPerm = requirePermission('referrals:read');

function buildCountRaw(
  db: Knex,
  countCol: string,
  dateCol: string,
  alias: string,
  periodStart?: string,
  periodEnd?: string,
): Knex.Raw {
  const conditions: string[] = [`${countCol} IS NOT NULL`];
  const bindings: string[] = [];

  if (periodStart) {
    conditions.push(`${dateCol} >= ?`);
    bindings.push(periodStart);
  }
  if (periodEnd) {
    conditions.push(`${dateCol} <= ?`);
    bindings.push(periodEnd);
  }

  return db.raw(
    `COUNT(*) FILTER (WHERE ${conditions.join(' AND ')})::int as ${alias}`,
    bindings,
  );
}

export async function leaderboardRoutes(
  app: FastifyInstance,
  opts: { db: Knex },
): Promise<void> {
  const { db } = opts;

  // GET /leaderboard — ranked by cases_started DESC
  app.get('/leaderboard', {
    schema: { querystring: LeaderboardQuery, tags: ['Leaderboard'], summary: 'Get referral leaderboard' } as object,
    preHandler: [readPerm],
  }, async (req, reply) => {
    const query = req.query as {
      location_id: string;
      referrer_type?: string;
      period_start?: string;
      period_end?: string;
      limit?: number;
    };

    const effectiveLimit = Math.min(Math.max(query.limit ?? 20, 1), 100);

    let q = db('referrers')
      .leftJoin('referrals', 'referrals.referrer_id', 'referrers.id')
      .where('referrers.location_id', query.location_id)
      .groupBy(
        'referrers.id',
        'referrers.name',
        'referrers.referrer_type',
        'referrers.practice_name',
      );

    if (query.referrer_type) {
      q = q.where('referrers.referrer_type', query.referrer_type);
    }

    q = q.select(
      'referrers.id as referrer_id',
      'referrers.name',
      'referrers.referrer_type',
      'referrers.practice_name',
      buildCountRaw(db, 'referrals.id', 'referrals.created_at', 'total_referrals', query.period_start, query.period_end),
      buildCountRaw(db, 'referrals.exam_scheduled_at', 'referrals.exam_scheduled_at', 'exams_scheduled', query.period_start, query.period_end),
      buildCountRaw(db, 'referrals.converted_at', 'referrals.converted_at', 'cases_started', query.period_start, query.period_end),
    );

    q = q.orderByRaw('cases_started DESC, referrers.name ASC');
    q = q.limit(effectiveLimit);

    const rows = await q;
    return reply.status(200).send({ data: rows });
  });
}
