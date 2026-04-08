import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { Type } from '@sinclair/typebox';
import { requirePermission } from '@ortho/auth-middleware';
import * as campaignsRepo from '../repositories/campaigns.repo.js';
import * as campaignEventsRepo from '../repositories/campaign-events.repo.js';
import * as campaignCommentsRepo from '../repositories/campaign-comments.repo.js';
import {
  validateTransition,
  targetStatus,
  validateRejectComment,
} from '../services/campaign-service.js';

const IdParams = Type.Object({
  id: Type.String(),
});

const ApproveBody = Type.Object({
  comment: Type.Optional(Type.String()),
});

const RejectBody = Type.Object({
  comment: Type.String(),
});

const CancelBody = Type.Object({
  reason: Type.Optional(Type.String()),
});

const writePerm = requirePermission('campaigns:write');
const managePerm = requirePermission('campaigns:manage');

export async function workflowRoutes(
  app: FastifyInstance,
  opts: { db: Knex },
): Promise<void> {
  const { db } = opts;

  // POST /campaigns/:id/submit
  app.post('/:id/submit', {
    schema: { params: IdParams },
    preHandler: [writePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const campaign = await campaignsRepo.findById(db, id);
    if (!campaign) {
      return reply.status(404).send({ error: 'not found' });
    }

    const check = validateTransition(campaign.status, 'submit');
    if (!check.ok) {
      return reply.status(check.httpStatus ?? 409).send({ error: check.error });
    }

    const newStatus = targetStatus(campaign.status, 'submit');
    const updated = await campaignsRepo.update(db, id, { status: newStatus });

    await campaignEventsRepo.insertEvent(db, {
      campaign_id: id,
      from_status: campaign.status,
      to_status: newStatus,
      actor_id: req.user!.sub,
    });

    return reply.status(200).send({
      campaign_id: updated.id,
      status: updated.status,
    });
  });

  // POST /campaigns/:id/approve
  app.post('/:id/approve', {
    schema: { params: IdParams, body: ApproveBody },
    preHandler: [writePerm, managePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { comment?: string };

    const campaign = await campaignsRepo.findById(db, id);
    if (!campaign) {
      return reply.status(404).send({ error: 'not found' });
    }

    const check = validateTransition(campaign.status, 'approve');
    if (!check.ok) {
      return reply.status(check.httpStatus ?? 409).send({ error: check.error });
    }

    const newStatus = targetStatus(campaign.status, 'approve');
    const updated = await campaignsRepo.update(db, id, {
      status: newStatus,
      approved_by: req.user!.sub,
      approved_at: new Date(),
    });

    await campaignEventsRepo.insertEvent(db, {
      campaign_id: id,
      from_status: campaign.status,
      to_status: newStatus,
      actor_id: req.user!.sub,
    });

    if (body.comment) {
      await campaignCommentsRepo.insertComment(db, {
        campaign_id: id,
        author_id: req.user!.sub,
        body: body.comment,
      });
    }

    return reply.status(200).send({
      campaign_id: updated.id,
      status: updated.status,
    });
  });

  // POST /campaigns/:id/reject
  app.post('/:id/reject', {
    schema: { params: IdParams, body: RejectBody },
    preHandler: [writePerm, managePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { comment: string };

    const commentCheck = validateRejectComment(body.comment);
    if (!commentCheck.ok) {
      return reply.status(400).send({ error: commentCheck.error });
    }

    const campaign = await campaignsRepo.findById(db, id);
    if (!campaign) {
      return reply.status(404).send({ error: 'not found' });
    }

    const check = validateTransition(campaign.status, 'reject');
    if (!check.ok) {
      return reply.status(check.httpStatus ?? 409).send({ error: check.error });
    }

    const newStatus = targetStatus(campaign.status, 'reject');
    const updated = await campaignsRepo.update(db, id, { status: newStatus });

    await campaignEventsRepo.insertEvent(db, {
      campaign_id: id,
      from_status: campaign.status,
      to_status: newStatus,
      actor_id: req.user!.sub,
    });

    await campaignCommentsRepo.insertComment(db, {
      campaign_id: id,
      author_id: req.user!.sub,
      body: body.comment,
    });

    return reply.status(200).send({
      campaign_id: updated.id,
      status: updated.status,
    });
  });

  // POST /campaigns/:id/cancel
  app.post('/:id/cancel', {
    schema: { params: IdParams, body: CancelBody },
    preHandler: [writePerm, managePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { reason?: string };

    const campaign = await campaignsRepo.findById(db, id);
    if (!campaign) {
      return reply.status(404).send({ error: 'not found' });
    }

    const check = validateTransition(campaign.status, 'cancel');
    if (!check.ok) {
      return reply.status(check.httpStatus ?? 409).send({ error: check.error });
    }

    const newStatus = targetStatus(campaign.status, 'cancel');
    const updated = await campaignsRepo.update(db, id, { status: newStatus });

    await campaignEventsRepo.insertEvent(db, {
      campaign_id: id,
      from_status: campaign.status,
      to_status: newStatus,
      actor_id: req.user!.sub,
      comment: body.reason ?? null,
    });

    return reply.status(200).send({
      campaign_id: updated.id,
      status: updated.status,
    });
  });

  // Phase 2 stubs
  app.post('/:id/schedule', {
    schema: { params: IdParams },
    preHandler: [writePerm],
  }, async (_req, reply) => {
    return reply.status(501).send({ error: 'Not Implemented' });
  });

  app.delete('/:id/schedule', {
    schema: { params: IdParams },
    preHandler: [writePerm],
  }, async (_req, reply) => {
    return reply.status(501).send({ error: 'Not Implemented' });
  });

  app.post('/:id/send-now', {
    schema: { params: IdParams },
    preHandler: [writePerm],
  }, async (_req, reply) => {
    return reply.status(501).send({ error: 'Not Implemented' });
  });
}
