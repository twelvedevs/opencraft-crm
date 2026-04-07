import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import type { Queue } from 'bullmq';
import { Type } from '@sinclair/typebox';
import * as bulkSendJobsRepo from '../repositories/bulk-send-jobs.repo.js';

const CreateBulkSendBody = Type.Object({
  segment: Type.Unknown(),
  body: Type.String({ minLength: 1 }),
  location_id: Type.String({ format: 'uuid' }),
});

const JobIdParams = Type.Object({ job_id: Type.String({ format: 'uuid' }) });

const ALLOWED_ROLES = ['call_center_manager', 'marketing_manager', 'super_admin'];

function hasLocationAccess(userLocations: string[], locationId: string): boolean {
  if (userLocations.length === 0) return true;
  return userLocations.includes(locationId);
}

export async function bulkSendsRoute(
  app: FastifyInstance,
  opts: { db: Knex; bulkSendQueue: Queue },
): Promise<void> {
  const { db, bulkSendQueue } = opts;

  // POST /conversations/bulk-sends
  app.post('/bulk-sends', { schema: { body: CreateBulkSendBody } }, async (req, reply) => {
    const body = req.body as { segment: unknown; body: string; location_id: string };

    if (!req.user) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    if (!ALLOWED_ROLES.includes(req.user.role)) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    // call_center_manager restricted to own locations
    if (req.user.role === 'call_center_manager' && !hasLocationAccess(req.user.locations, body.location_id)) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    const job = await bulkSendJobsRepo.create(db, {
      location_id: body.location_id,
      segment: body.segment,
      body: body.body,
      created_by: req.user.sub,
    });

    await bulkSendQueue.add('bulk-send', {
      job_id: job.id,
      location_id: body.location_id,
      segment: body.segment,
      body: body.body,
    });

    return reply.status(202).send({ job_id: job.id });
  });

  // GET /conversations/bulk-sends/:job_id
  app.get('/bulk-sends/:job_id', { schema: { params: JobIdParams } }, async (req, reply) => {
    const { job_id } = req.params as { job_id: string };

    if (!req.user) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    const job = await bulkSendJobsRepo.findById(db, job_id);
    if (!job) {
      return reply.status(404).send({ error: 'not_found' });
    }

    if (!hasLocationAccess(req.user.locations, job.location_id)) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    return reply.send({
      status: job.status,
      total: job.total,
      sent: job.sent,
      failed: job.failed,
    });
  });
}
