import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { Type } from '@sinclair/typebox';
import * as conversationsRepo from '../repositories/conversations.repo.js';
import * as messagesRepo from '../repositories/messages.repo.js';
import * as notesRepo from '../repositories/notes.repo.js';
import * as readsRepo from '../repositories/reads.repo.js';

const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

const ListQuery = Type.Object({
  location_id: Type.String({ format: 'uuid' }),
  lead_id: Type.Optional(Type.String({ format: 'uuid' })),
  status: Type.Optional(Type.String()),
  assigned_to: Type.Optional(Type.String({ format: 'uuid' })),
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

const PatchBody = Type.Object({
  assigned_to: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  escalated: Type.Optional(Type.Boolean()),
  status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('closed')])),
  agent_mode_active: Type.Optional(Type.Boolean()),
});

function hasLocationAccess(userLocations: string[], locationId: string): boolean {
  // Empty locations array means all-locations access (manager/admin roles)
  if (userLocations.length === 0) return true;
  return userLocations.includes(locationId);
}

export async function conversationsRoute(
  app: FastifyInstance,
  opts: { db: Knex },
): Promise<void> {
  const { db } = opts;

  // GET /conversations
  app.get('/', { schema: { querystring: ListQuery } }, async (req, reply) => {
    const query = req.query as {
      location_id: string;
      lead_id?: string;
      status?: string;
      assigned_to?: string;
      page?: number;
      limit?: number;
    };

    if (!req.user) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    if (!hasLocationAccess(req.user.locations, query.location_id)) {
      return reply.status(403).send({ error: 'forbidden' });
    }

    const result = await conversationsRepo.list(db, {
      location_id: query.location_id,
      lead_id: query.lead_id,
      status: query.status,
      assigned_to: query.assigned_to,
      page: query.page,
      limit: query.limit,
      user_id: req.user.sub,
    });

    return reply.send(result);
  });

  // GET /conversations/:id
  app.get('/:id', { schema: { params: IdParams } }, async (req, reply) => {
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

    const [messages, notes] = await Promise.all([
      messagesRepo.listByConversation(db, id, { limit: 50 }),
      notesRepo.listByConversation(db, id),
    ]);

    return reply.send({ ...conversation, messages, notes });
  });

  // PATCH /conversations/:id
  app.patch('/:id', { schema: { params: IdParams, body: PatchBody } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      assigned_to?: string | null;
      escalated?: boolean;
      status?: 'open' | 'closed';
      agent_mode_active?: boolean;
    };

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

    // Only marketing_manager can enable agent mode
    if (body.agent_mode_active === true && req.user.role !== 'marketing_manager') {
      return reply.status(403).send({ error: 'forbidden' });
    }

    const updateData: Parameters<typeof conversationsRepo.update>[2] = {};
    if (body.assigned_to !== undefined) updateData.assigned_to = body.assigned_to;
    if (body.escalated !== undefined) updateData.escalated = body.escalated;
    if (body.status !== undefined) updateData.status = body.status;
    if (body.agent_mode_active !== undefined) {
      updateData.agent_mode_active = body.agent_mode_active;
      if (body.agent_mode_active === true) {
        updateData.agent_exchange_count = 0;
      }
    }

    const updated = await conversationsRepo.update(db, id, updateData);
    return reply.send(updated);
  });

  // POST /conversations/:id/read
  app.post('/:id/read', { schema: { params: IdParams } }, async (req, reply) => {
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

    const latestMessageId = await messagesRepo.getLatestMessageId(db, id);
    if (latestMessageId) {
      await readsRepo.upsert(db, id, req.user.sub, latestMessageId);
    }

    return reply.send({ ok: true });
  });
}
