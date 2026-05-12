import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import type { EventBus } from '@ortho/event-bus';
import { Type } from '@sinclair/typebox';
import { requireRole } from '@ortho/auth-middleware';
import '@ortho/auth-middleware';
import * as tagService from '../services/tag-service.js';
import * as tagRepository from '../repositories/tag-repository.js';
import * as leadRepository from '../repositories/lead-repository.js';

const MANAGER_PLUS = ['marketing_manager', 'super_admin'];

const TagIdParams = Type.Object({
  id: Type.String(),
});

const LeadTagParams = Type.Object({
  id: Type.String(),
  tag_id: Type.String(),
});

const ListTagsQuery = Type.Object({
  location_id: Type.Optional(Type.String()),
});

const CreateTagBody = Type.Object({
  name: Type.String(),
  location_id: Type.Optional(Type.String()),
});

const ApplyTagBody = Type.Object({
  tag_id: Type.String(),
});

export async function tagRoutes(
  app: FastifyInstance,
  opts: { db: Knex; eventBus: EventBus },
): Promise<void> {
  const { db } = opts;

  // GET /tags
  app.get('/tags', {
    schema: { querystring: ListTagsQuery, tags: ['Tags'], summary: 'List all tags' } as object,
  }, async (req, reply) => {
    const { location_id } = req.query as { location_id?: string };
    const tags = await tagService.listTags(db, location_id);
    return reply.status(200).send(tags);
  });

  // POST /tags
  app.post('/tags', {
    schema: { body: CreateTagBody, tags: ['Tags'], summary: 'Create tag' } as object,
    preHandler: [requireRole(MANAGER_PLUS)],
  }, async (req, reply) => {
    const body = req.body as { name: string; location_id?: string };

    try {
      const tag = await tagService.createTag(db, {
        name: body.name,
        location_id: body.location_id ?? null,
        created_by: req.user!.sub,
      });
      return reply.status(201).send(tag);
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === '23505'
      ) {
        return reply.status(409).send({ error: 'tag name already exists' });
      }
      throw err;
    }
  });

  // DELETE /tags/:id
  app.delete('/tags/:id', {
    schema: { params: TagIdParams, tags: ['Tags'], summary: 'Delete tag' } as object,
    preHandler: [requireRole(MANAGER_PLUS)],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const tag = await tagRepository.findTagById(db, id);
    if (!tag) {
      return reply.status(404).send({ error: 'not found' });
    }

    await tagService.deleteTag(db, id);
    return reply.status(204).send();
  });

  // POST /leads/:id/tags
  app.post('/leads/:id/tags', {
    schema: { params: Type.Object({ id: Type.String() }), body: ApplyTagBody, tags: ['Tags'], summary: 'Apply tag to lead' } as object,
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tag_id } = req.body as { tag_id: string };

    const lead = await leadRepository.findById(db, id);
    if (!lead) {
      return reply.status(404).send({ error: 'not found' });
    }

    const tag = await tagRepository.findTagById(db, tag_id);
    if (!tag) {
      return reply.status(404).send({ error: 'not found' });
    }

    await tagService.applyTagToLead(db, id, tag_id, req.user!.sub);
    return reply.status(200).send({ ok: true });
  });

  // DELETE /leads/:id/tags/:tag_id
  app.delete('/leads/:id/tags/:tag_id', {
    schema: { params: LeadTagParams, tags: ['Tags'], summary: 'Remove tag from lead' } as object,
  }, async (req, reply) => {
    const { id, tag_id } = req.params as { id: string; tag_id: string };
    await tagService.removeTagFromLead(db, id, tag_id);
    return reply.status(204).send();
  });
}
