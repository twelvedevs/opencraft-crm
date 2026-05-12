import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { Type } from '@sinclair/typebox';
import { requirePermission } from '@ortho/auth-middleware';
import * as referrerRepo from '../repositories/referrer.repo.js';
import * as referralLinkRepo from '../repositories/referral-link.repo.js';
import * as linkService from '../services/link.service.js';
import { env } from '../env.js';

const ReferrerIdParams = Type.Object({
  id: Type.String(),
});

const LinkIdParams = Type.Object({
  id: Type.String(),
});

const PatchLinkStatusBody = Type.Object({
  status: Type.Union([Type.Literal('active'), Type.Literal('inactive')]),
});

const readPerm = requirePermission('referrals:read');
const writePerm = requirePermission('referrals:write');

export async function referralLinksRoutes(
  app: FastifyInstance,
  opts: { db: Knex },
): Promise<void> {
  const { db } = opts;

  // POST /referrers/:id/links — generate new link, deactivate existing active link
  app.post('/referrers/:id/links', {
    schema: { params: ReferrerIdParams, tags: ['Referral Links'], summary: 'Create referral link' } as object,
    preHandler: [writePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const referrer = await referrerRepo.findById(db, id);
    if (!referrer) {
      return reply.status(404).send({ error: 'Referrer not found' });
    }

    // Deactivate existing active links
    await linkService.deactivateAllForReferrer(db, id);

    // Generate new link
    const link = await linkService.createLink(
      db,
      id,
      env.DEFAULT_REFERRAL_LANDING_URL,
      req.user!.sub,
    );

    return reply.status(201).send(link);
  });

  // GET /referrers/:id/links — all links (active + inactive) with click_count
  app.get('/referrers/:id/links', {
    schema: { params: ReferrerIdParams, tags: ['Referral Links'], summary: 'List referral links' } as object,
    preHandler: [readPerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const referrer = await referrerRepo.findById(db, id);
    if (!referrer) {
      return reply.status(404).send({ error: 'Referrer not found' });
    }

    const links = await referralLinkRepo.findAllByReferrerId(db, id);
    return reply.status(200).send({ data: links });
  });

  // PATCH /links/:id/status — activating deactivates other active links for same referrer
  app.patch('/links/:id/status', {
    schema: { params: LinkIdParams, body: PatchLinkStatusBody, tags: ['Referral Links'], summary: 'Update referral link status' } as object,
    preHandler: [writePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { status } = req.body as { status: 'active' | 'inactive' };

    const existingLink = await db('referral_links').where({ id }).first() as { id: string; referrer_id: string } | undefined;
    if (!existingLink) {
      return reply.status(404).send({ error: 'Link not found' });
    }

    // If activating, deactivate all other active links for this referrer first
    if (status === 'active') {
      await referralLinkRepo.deactivateAllForReferrer(db, existingLink.referrer_id);
    }

    const updated = await referralLinkRepo.updateStatus(db, id, status);
    return reply.status(200).send(updated);
  });
}
