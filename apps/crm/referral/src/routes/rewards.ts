import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { Type } from '@sinclair/typebox';
import { requirePermission } from '@ortho/auth-middleware';
import * as rewardService from '../services/reward.service.js';

const IdParams = Type.Object({
  id: Type.String(),
});

const ListRewardsQuery = Type.Object({
  location_id: Type.String(),
  status: Type.Optional(Type.String()),
  referrer_id: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
});

const PatchRewardBody = Type.Object({
  status: Type.Literal('issued'),
  reward_type: Type.String(),
  reward_amount: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  reward_notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const readPerm = requirePermission('referrals:read');
const writePerm = requirePermission('referrals:write');

export async function rewardsRoutes(
  app: FastifyInstance,
  opts: { db: Knex },
): Promise<void> {
  const { db } = opts;

  // GET /rewards — paginated list, default sort created_at ASC
  app.get('/rewards', {
    schema: { querystring: ListRewardsQuery, tags: ['Rewards'], summary: 'List pending rewards' } as object,
    preHandler: [readPerm],
  }, async (req, reply) => {
    const query = req.query as {
      location_id: string;
      status?: string;
      referrer_id?: string;
      cursor?: string;
      limit?: number;
    };

    const result = await rewardService.list(db, query);
    return reply.status(200).send({ data: result.items, nextCursor: result.nextCursor });
  });

  // PATCH /rewards/:id — issue reward
  app.patch('/rewards/:id', {
    schema: { params: IdParams, body: PatchRewardBody, tags: ['Rewards'], summary: 'Mark reward as issued' } as object,
    preHandler: [writePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      status: 'issued';
      reward_type: string;
      reward_amount?: number | null;
      reward_notes?: string | null;
    };

    try {
      const result = await rewardService.issueReward(db, id, {
        reward_type: body.reward_type,
        reward_amount: body.reward_amount,
        reward_notes: body.reward_notes,
        issuedBy: req.user!.sub,
      });
      return reply.status(200).send(result);
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number };
      const statusCode = error.statusCode ?? 500;
      return reply.status(statusCode).send({ error: error.message });
    }
  });
}
