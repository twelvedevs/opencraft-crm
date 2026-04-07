import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { Type } from '@sinclair/typebox';
import * as conversationsRepo from '../repositories/conversations.repo.js';
import { getDraftReplies, getSummary, getObjectionStrategies } from '../services/ai-features.js';

const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

const ObjectionBody = Type.Object({
  objection_type: Type.String({ minLength: 1 }),
});

function hasLocationAccess(userLocations: string[], locationId: string): boolean {
  if (userLocations.length === 0) return true;
  return userLocations.includes(locationId);
}

export async function aiRoute(
  app: FastifyInstance,
  opts: { db: Knex },
): Promise<void> {
  const { db } = opts;

  // POST /conversations/:id/ai/drafts
  app.post('/:id/ai/drafts', { schema: { params: IdParams } }, async (req, reply) => {
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

    const result = await getDraftReplies(id, db);
    return reply.send(result);
  });

  // POST /conversations/:id/ai/summary
  app.post('/:id/ai/summary', { schema: { params: IdParams } }, async (req, reply) => {
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

    const result = await getSummary(id, db);
    return reply.send(result);
  });

  // POST /conversations/:id/ai/objection
  app.post('/:id/ai/objection', { schema: { params: IdParams, body: ObjectionBody } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { objection_type: string };

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

    const result = await getObjectionStrategies(id, body.objection_type, db);
    return reply.send(result);
  });
}
