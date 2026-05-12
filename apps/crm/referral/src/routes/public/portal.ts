import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { Type } from '@sinclair/typebox';
import * as portalTokenRepo from '../../repositories/portal-token.repo.js';
import * as referrerRepo from '../../repositories/referrer.repo.js';
import * as referralRepo from '../../repositories/referral.repo.js';

const TokenParams = Type.Object({
  token: Type.String(),
});

export async function publicPortalRoutes(
  app: FastifyInstance,
  opts: { db: Knex },
): Promise<void> {
  const { db } = opts;

  // GET /referrals/portal/:token — doctor portal view
  app.get('/referrals/portal/:token', {
    schema: { params: TokenParams, tags: ['Public'], summary: 'Get referring doctor portal view' } as object,
  }, async (req, reply) => {
    const { token } = req.params as { token: string };

    const portalToken = await portalTokenRepo.findByToken(db, token);
    if (!portalToken) {
      return reply.status(404).send({ error: 'Unknown portal token' });
    }

    const referrer = await referrerRepo.findById(db, portalToken.referrer_id);
    if (!referrer) {
      return reply.status(404).send({ error: 'Referrer not found' });
    }

    // Fetch all referrals for this referrer (no pagination for portal)
    const { items: referrals } = await referralRepo.findByReferrerId(db, {
      referrer_id: referrer.id,
      limit: 200,
    });

    // Compute lifetime stats from referrals
    const total_referrals = referrals.length;
    const exams_scheduled = referrals.filter(
      (r) => r.exam_scheduled_at !== null,
    ).length;
    const cases_started = referrals.filter(
      (r) => r.status === 'converted',
    ).length;

    return reply.status(200).send({
      referrer: {
        id: referrer.id,
        name: referrer.name,
        practice_name: referrer.practice_name,
        location_id: referrer.location_id,
      },
      stats: {
        total_referrals,
        exams_scheduled,
        cases_started,
      },
      referrals: referrals.map((r) => ({
        id: r.id,
        status: r.status,
        exam_scheduled_at: r.exam_scheduled_at,
        converted_at: r.converted_at,
      })),
    });
  });
}
