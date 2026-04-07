import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import type { Queue } from 'bullmq';
import { Type } from '@sinclair/typebox';
import * as conversationsRepo from '../repositories/conversations.repo.js';
import * as scheduledRepo from '../repositories/scheduled.repo.js';

const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

const ScheduledMsgParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  msg_id: Type.String({ format: 'uuid' }),
});

const CreateScheduledBody = Type.Object({
  body: Type.String({ minLength: 1 }),
  media_url: Type.Optional(Type.String()),
  scheduled_for: Type.String({ format: 'date-time' }),
});

function hasLocationAccess(userLocations: string[], locationId: string): boolean {
  if (userLocations.length === 0) return true;
  return userLocations.includes(locationId);
}

export async function scheduledRoute(
  app: FastifyInstance,
  opts: { db: Knex; scheduledSendQueue: Queue },
): Promise<void> {
  const { db, scheduledSendQueue } = opts;

  // POST /conversations/:id/scheduled-messages
  app.post('/:id/scheduled-messages', { schema: { params: IdParams, body: CreateScheduledBody } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { body: string; media_url?: string; scheduled_for: string };

    if (!req.user) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    const conversation = await conversationsRepo.findById(db, id);
    if (!conversation) {
      return reply.status(404).send({ error: 'not_found' });
    }

    if (!hasLocationAccess(req.user.locations, conversation.location_id)) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    const scheduledFor = new Date(body.scheduled_for);
    const delay = scheduledFor.getTime() - Date.now();

    const scheduled = await scheduledRepo.create(db, {
      conversation_id: id,
      body: body.body,
      media_url: body.media_url ?? null,
      scheduled_for: scheduledFor,
      created_by: req.user.sub,
    });

    const job = await scheduledSendQueue.add(
      'send',
      { scheduled_message_id: scheduled.id },
      { delay: Math.max(delay, 0) },
    );

    await scheduledRepo.updateBullmqJobId(db, scheduled.id, job.id!);

    return reply.status(201).send({ scheduled_message_id: scheduled.id });
  });

  // GET /conversations/:id/scheduled-messages
  app.get('/:id/scheduled-messages', { schema: { params: IdParams } }, async (req, reply) => {
    const { id } = req.params as { id: string };

    if (!req.user) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    const conversation = await conversationsRepo.findById(db, id);
    if (!conversation) {
      return reply.status(404).send({ error: 'not_found' });
    }

    if (!hasLocationAccess(req.user.locations, conversation.location_id)) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    const messages = await scheduledRepo.listPending(db, id);
    return reply.send(messages);
  });

  // DELETE /conversations/:id/scheduled-messages/:msg_id
  app.delete('/:id/scheduled-messages/:msg_id', { schema: { params: ScheduledMsgParams } }, async (req, reply) => {
    const { id, msg_id } = req.params as { id: string; msg_id: string };

    if (!req.user) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    const conversation = await conversationsRepo.findById(db, id);
    if (!conversation) {
      return reply.status(404).send({ error: 'not_found' });
    }

    if (!hasLocationAccess(req.user.locations, conversation.location_id)) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    const scheduled = await scheduledRepo.findById(db, msg_id);
    if (!scheduled || scheduled.conversation_id !== id) {
      return reply.status(404).send({ error: 'not_found' });
    }

    if (scheduled.status !== 'pending') {
      return reply.status(409).send({ error: 'conflict' });
    }

    await scheduledRepo.updateStatus(db, msg_id, 'cancelled');

    // Remove the BullMQ job if it exists
    if (scheduled.bullmq_job_id) {
      const job = await scheduledSendQueue.getJob(scheduled.bullmq_job_id);
      if (job) {
        await job.remove();
      }
    }

    return reply.send({ ok: true });
  });
}
