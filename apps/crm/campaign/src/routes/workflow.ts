import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { Type } from '@sinclair/typebox';
import { Queue } from 'bullmq';
import { requirePermission } from '@ortho/auth-middleware';
import * as campaignsRepo from '../repositories/campaigns.repo.js';
import * as campaignEventsRepo from '../repositories/campaign-events.repo.js';
import * as campaignCommentsRepo from '../repositories/campaign-comments.repo.js';
import {
  validateTransition,
  targetStatus,
  validateRejectComment,
} from '../services/campaign-service.js';
import { bullmqRedis, ORCHESTRATE_QUEUE } from '../queue/connection.js';

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

const ScheduleBody = Type.Object({
  scheduled_for: Type.String(),
});

const writePerm = requirePermission('campaigns:write');
const managePerm = requirePermission('campaigns:manage');

export async function workflowRoutes(
  app: FastifyInstance,
  opts: { db: Knex },
): Promise<void> {
  const { db } = opts;
  const orchestrateQueue = new Queue(ORCHESTRATE_QUEUE, {
    connection: bullmqRedis,
  });

  // POST /campaigns/:id/submit
  app.post('/:id/submit', {
    schema: { params: IdParams, tags: ['Workflow'], summary: 'Submit campaign for approval' },
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
    schema: { params: IdParams, body: ApproveBody, tags: ['Workflow'], summary: 'Approve campaign' },
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
    schema: { params: IdParams, body: RejectBody, tags: ['Workflow'], summary: 'Reject campaign' },
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
    schema: { params: IdParams, body: CancelBody, tags: ['Workflow'], summary: 'Cancel campaign' },
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

    // Remove pending BullMQ job if exists
    if (campaign.orchestrate_job_id) {
      try {
        await orchestrateQueue.remove(campaign.orchestrate_job_id);
      } catch {
        // Job may already be processing or gone
      }
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

  // POST /campaigns/:id/schedule
  app.post('/:id/schedule', {
    schema: { params: IdParams, body: ScheduleBody, tags: ['Workflow'], summary: 'Schedule campaign send' },
    preHandler: [writePerm, managePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { scheduled_for: string };

    const scheduledFor = new Date(body.scheduled_for);
    if (isNaN(scheduledFor.getTime()) || scheduledFor <= new Date()) {
      return reply.status(400).send({ error: 'scheduled_for must be a valid future ISO timestamp' });
    }

    const campaign = await campaignsRepo.findById(db, id);
    if (!campaign) {
      return reply.status(404).send({ error: 'not found' });
    }

    const check = validateTransition(campaign.status, 'schedule');
    if (!check.ok) {
      return reply.status(check.httpStatus ?? 409).send({ error: check.error });
    }

    const delay = scheduledFor.getTime() - Date.now();
    const job = await orchestrateQueue.add(
      'orchestrate',
      { campaign_id: id },
      { delay },
    );

    const newStatus = targetStatus(campaign.status, 'schedule');
    const updated = await campaignsRepo.update(db, id, {
      status: newStatus,
      scheduled_for: scheduledFor,
      orchestrate_job_id: job.id!,
    });

    await campaignEventsRepo.insertEvent(db, {
      campaign_id: id,
      from_status: campaign.status,
      to_status: newStatus,
      actor_id: req.user!.sub,
    });

    return reply.status(200).send({
      campaign_id: updated.id,
      status: updated.status,
      scheduled_for: updated.scheduled_for,
    });
  });

  // DELETE /campaigns/:id/schedule (unschedule)
  app.delete('/:id/schedule', {
    schema: { params: IdParams, tags: ['Workflow'], summary: 'Unschedule campaign' } as object,
    preHandler: [writePerm, managePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const campaign = await campaignsRepo.findById(db, id);
    if (!campaign) {
      return reply.status(404).send({ error: 'not found' });
    }

    const check = validateTransition(campaign.status, 'unschedule');
    if (!check.ok) {
      return reply.status(check.httpStatus ?? 409).send({ error: check.error });
    }

    if (campaign.orchestrate_job_id) {
      try {
        await orchestrateQueue.remove(campaign.orchestrate_job_id);
      } catch {
        // Job may already be gone
      }
    }

    const newStatus = targetStatus(campaign.status, 'unschedule');
    const updated = await campaignsRepo.update(db, id, {
      status: newStatus,
      orchestrate_job_id: null,
    });

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

  // POST /campaigns/:id/send-now
  app.post('/:id/send-now', {
    schema: { params: IdParams, tags: ['Workflow'], summary: 'Send campaign immediately' } as object,
    preHandler: [writePerm, managePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const campaign = await campaignsRepo.findById(db, id);
    if (!campaign) {
      return reply.status(404).send({ error: 'not found' });
    }

    const check = validateTransition(campaign.status, 'send-now');
    if (!check.ok) {
      return reply.status(check.httpStatus ?? 409).send({ error: check.error });
    }

    const newStatus = targetStatus(campaign.status, 'send-now');
    const job = await orchestrateQueue.add(
      'orchestrate',
      { campaign_id: id },
      { delay: 0 },
    );

    const updated = await campaignsRepo.update(db, id, {
      status: newStatus,
      sent_at: new Date(),
      orchestrate_job_id: job.id!,
    });

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
}
