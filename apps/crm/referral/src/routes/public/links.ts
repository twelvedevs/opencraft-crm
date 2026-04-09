import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { Type } from '@sinclair/typebox';
import * as referralLinkRepo from '../../repositories/referral-link.repo.js';
import * as linkService from '../../services/link.service.js';

const CodeParams = Type.Object({
  code: Type.String(),
});

export async function publicLinksRoutes(
  app: FastifyInstance,
  opts: { db: Knex },
): Promise<void> {
  const { db } = opts;

  // GET /referrals/r/:code — click redirect
  app.get('/referrals/r/:code', {
    schema: { params: CodeParams },
  }, async (req, reply) => {
    const { code } = req.params as { code: string };

    const link = await referralLinkRepo.findByCode(db, code);
    if (!link) {
      return reply.status(404).send({ error: 'Unknown referral code' });
    }

    if (link.status === 'active') {
      // Fire-and-forget click increment
      linkService.recordClick(db, code);
      return reply.status(302).redirect(`${link.redirect_url}?ref=${code}`);
    }

    // Inactive code: redirect without ?ref=, no click increment
    return reply.status(302).redirect(link.redirect_url);
  });

  // GET /referrals/links/:code — code resolution
  app.get('/referrals/links/:code', {
    schema: { params: CodeParams },
  }, async (req, reply) => {
    const { code } = req.params as { code: string };

    const resolved = await linkService.resolveCode(db, code);
    if (!resolved) {
      return reply.status(404).send({ error: 'Unknown or inactive referral code' });
    }

    return reply.status(200).send(resolved);
  });
}
