import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { Type } from '@sinclair/typebox';
import { requirePermission } from '@ortho/auth-middleware';
import * as referralService from '../services/referral.service.js';
import * as rewardRepo from '../repositories/reward.repo.js';

const IdParams = Type.Object({
  id: Type.String(),
});

const ListReferralsQuery = Type.Object({
  location_id: Type.String(),
  referrer_id: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  created_after: Type.Optional(Type.String()),
  created_before: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
});

const PatchNotificationsBody = Type.Object({
  notify_on_exam: Type.Optional(Type.Boolean()),
  notify_on_conversion: Type.Optional(Type.Boolean()),
});

const readPerm = requirePermission('referrals:read');

export async function referralsRoutes(
  app: FastifyInstance,
  opts: { db: Knex },
): Promise<void> {
  const { db } = opts;

  // GET / — paginated list of referrals
  app.get('/', {
    schema: { querystring: ListReferralsQuery, tags: ['Referrals'], summary: 'List referrals' } as object,
    preHandler: [readPerm],
  }, async (req, reply) => {
    const query = req.query as {
      location_id: string;
      referrer_id?: string;
      status?: string;
      created_after?: string;
      created_before?: string;
      cursor?: string;
      limit?: number;
    };

    const result = await referralService.list(db, query);
    return reply.status(200).send({ data: result.items, nextCursor: result.nextCursor });
  });

  // GET /:id — full referral record including reward_event if exists
  app.get('/:id', {
    schema: { params: IdParams, tags: ['Referrals'], summary: 'Get referral by ID' } as object,
    preHandler: [readPerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const referral = await referralService.getById(db, id);
    if (!referral) {
      return reply.status(404).send({ error: 'Referral not found' });
    }

    const rewardEvent = await rewardRepo.findByReferralId(db, referral.id);

    return reply.status(200).send({
      ...referral,
      reward_event: rewardEvent ?? null,
    });
  });

  // PATCH /:id/notifications — update notification preferences
  app.patch('/:id/notifications', {
    schema: { params: IdParams, body: PatchNotificationsBody, tags: ['Referrals'], summary: 'Update referral notification settings' } as object,
    preHandler: [readPerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      notify_on_exam?: boolean;
      notify_on_conversion?: boolean;
    };

    const referral = await referralService.getById(db, id);
    if (!referral) {
      return reply.status(404).send({ error: 'Referral not found' });
    }

    const updated = await referralService.updateNotificationPrefs(db, id, body);
    return reply.status(200).send(updated);
  });
}
