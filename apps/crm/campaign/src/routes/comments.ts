import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { Type } from '@sinclair/typebox';
import { requirePermission } from '@ortho/auth-middleware';
import * as campaignsRepo from '../repositories/campaigns.repo.js';
import * as campaignCommentsRepo from '../repositories/campaign-comments.repo.js';

const IdParams = Type.Object({
  id: Type.String(),
});

const CreateCommentBody = Type.Object({
  body: Type.String({ minLength: 1 }),
});

const ListCommentsQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ default: 50 })),
  offset: Type.Optional(Type.Integer({ default: 0 })),
});

const writePerm = requirePermission('campaigns:write');

export async function commentsRoutes(
  app: FastifyInstance,
  opts: { db: Knex },
): Promise<void> {
  const { db } = opts;

  // POST /campaigns/:id/comments
  app.post('/:id/comments', {
    schema: { params: IdParams, body: CreateCommentBody, tags: ['Comments'], summary: 'Add review comment' },
    preHandler: [writePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { body: string };

    if (!body.body || body.body.trim() === '') {
      return reply.status(400).send({ error: 'Comment body is required' });
    }

    const campaign = await campaignsRepo.findById(db, id);
    if (!campaign) {
      return reply.status(404).send({ error: 'not found' });
    }

    const comment = await campaignCommentsRepo.insertComment(db, {
      campaign_id: id,
      author_id: req.user!.sub,
      body: body.body,
    });

    return reply.status(201).send({
      comment_id: comment.id,
      author_id: comment.author_id,
      body: comment.body,
      created_at: comment.created_at,
    });
  });

  // GET /campaigns/:id/comments
  app.get('/:id/comments', {
    schema: { params: IdParams, querystring: ListCommentsQuery, tags: ['Comments'], summary: 'List campaign comments' },
    preHandler: [writePerm],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { limit?: number; offset?: number };

    const campaign = await campaignsRepo.findById(db, id);
    if (!campaign) {
      return reply.status(404).send({ error: 'not found' });
    }

    const result = await campaignCommentsRepo.listByCampaignId(db, id, {
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });

    return reply.status(200).send(result);
  });
}
