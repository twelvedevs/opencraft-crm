import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { Type } from '@sinclair/typebox';
import * as conversationsRepo from '../repositories/conversations.repo.js';
import * as messagesRepo from '../repositories/messages.repo.js';
import { sendOutbound } from '../services/outbound-sender.js';
import { hasLocationAccess } from '../lib/auth-helpers.js';

const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

const MessagesQuery = Type.Object({
  before: Type.Optional(Type.String({ format: 'uuid' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

const SendBody = Type.Object({
  body: Type.String({ minLength: 1 }),
  media_url: Type.Optional(Type.String({ format: 'uri' })),
});

export async function messagesRoute(
  app: FastifyInstance,
  opts: { db: Knex },
): Promise<void> {
  const { db } = opts;

  // GET /conversations/:id/messages
  app.get('/:id/messages', { schema: { tags: ['Messages'], summary: 'List conversation messages', params: IdParams, querystring: MessagesQuery } as object }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { before?: string; limit?: number };

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

    const limit = query.limit ?? 50;
    const messages = await messagesRepo.listByConversation(db, id, {
      before: query.before,
      limit: limit + 1,
    });

    const hasMore = messages.length > limit;
    const result = hasMore ? messages.slice(0, limit) : messages;

    return reply.send({ messages: result, hasMore });
  });

  // POST /conversations/:id/messages
  app.post('/:id/messages', { schema: { tags: ['Messages'], summary: 'Send message in conversation', params: IdParams, body: SendBody } as object }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { body: string; media_url?: string };

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

    const result = await sendOutbound(db, {
      conversationId: id,
      body: body.body,
      mediaUrl: body.media_url,
      authorId: req.user.sub,
    });

    return reply.send({ message_id: result.messageId, status: result.status });
  });
}
