import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { TemplatesRepo, type TemplateRow } from '../repositories/templates.js';
import { isServiceApiKey, verifyJwt } from '../plugins/auth.js';
import { templateCache } from '../services/template-cache.js';

export default async function templateRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.requireRole('marketing_staff'));

  app.post(
    '/templates',
    {
      schema: {
        tags: ['Templates'],
        summary: 'Create template',
        body: Type.Object({
          name: Type.String(),
          channel: Type.Union([Type.Literal('sms'), Type.Literal('email')]),
        }),
      } as object,
    },
    async (request, reply) => {
      const { name, channel } = request.body as { name: string; channel: 'sms' | 'email' };

      let created_by: string | null = null;
      if (!isServiceApiKey(request.headers.authorization)) {
        const claims = await verifyJwt(request.headers.authorization, app.jwtSecret);
        created_by = claims.sub;
      }

      const repo = new TemplatesRepo(app.db);

      try {
        const template = await repo.create({ name, channel, created_by });
        return reply.status(201).send(template);
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e.code === '23505') {
          return reply.status(409).send({ error: 'Template name already exists' });
        }
        throw err;
      }
    },
  );

  app.get(
    '/templates',
    {
      schema: {
        tags: ['Templates'],
        summary: 'List templates',
        querystring: Type.Object({
          channel: Type.Optional(Type.Union([Type.Literal('sms'), Type.Literal('email')])),
          status: Type.Optional(
            Type.Union([Type.Literal('draft'), Type.Literal('active'), Type.Literal('disabled')]),
          ),
          sort: Type.Optional(Type.Union([Type.Literal('created_at'), Type.Literal('updated_at')])),
          order: Type.Optional(Type.Union([Type.Literal('asc'), Type.Literal('desc')])),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
          offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
        }),
      } as object,
    },
    async (request, reply) => {
      const q = request.query as {
        channel?: 'sms' | 'email';
        status?: 'draft' | 'active' | 'disabled';
        sort?: 'created_at' | 'updated_at';
        order?: 'asc' | 'desc';
        limit?: number;
        offset?: number;
      };

      const resolvedLimit = q.limit ?? 20;
      const resolvedOffset = q.offset ?? 0;

      const repo = new TemplatesRepo(app.db);
      const { rows, total } = await repo.list({
        channel: q.channel,
        status: q.status,
        sort: q.sort ?? 'updated_at',
        order: q.order ?? 'desc',
        limit: resolvedLimit,
        offset: resolvedOffset,
      });

      return reply.status(200).send({
        data: rows,
        total,
        limit: resolvedLimit,
        offset: resolvedOffset,
      });
    },
  );

  app.get(
    '/templates/:id',
    { schema: { tags: ['Templates'], summary: 'Get template by ID' } as object },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const repo = new TemplatesRepo(app.db);

      const template = await repo.findById(id);
      if (!template) {
        return reply.status(404).send({ error: 'Not found' });
      }

      const draftVersion = await repo.findVersionContent(template.id, template.current_version);
      const draftContent = draftVersion
        ? {
            version: draftVersion.version,
            body_text: draftVersion.body_text,
            subject: draftVersion.subject,
            body_html: draftVersion.body_html,
            body_unlayer: draftVersion.body_unlayer,
          }
        : null;

      let activeContent: {
        version: number;
        body_text: string | null;
        subject: string | null;
        body_html: string | null;
        body_unlayer: unknown | null;
      } | null = null;

      if (template.active_version !== null) {
        const activeVersion = await repo.findVersionContent(template.id, template.active_version);
        if (activeVersion) {
          activeContent = {
            version: activeVersion.version,
            body_text: activeVersion.body_text,
            subject: activeVersion.subject,
            body_html: activeVersion.body_html,
            body_unlayer: activeVersion.body_unlayer,
          };
        }
      }

      return reply.status(200).send({
        ...template,
        draft_content: draftContent,
        active_content: activeContent,
      });
    },
  );

  app.post(
    '/templates/:id/enable',
    { schema: { tags: ['Templates'], summary: 'Enable template' } as object, preHandler: app.requireRole('marketing_manager') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const repo = new TemplatesRepo(app.db);

      const template = await repo.findById(id);
      if (!template) {
        return reply.status(404).send({ error: 'Not found' });
      }

      if (template.active_version === null) {
        return reply.status(400).send({ error: 'Template has no active version' });
      }

      if (template.status !== 'disabled') {
        return reply.status(400).send({ error: 'Template is not disabled' });
      }

      const updated = await repo.enable(id);
      return reply.status(200).send(updated);
    },
  );

  app.post(
    '/templates/:id/disable',
    { schema: { tags: ['Templates'], summary: 'Disable template' } as object, preHandler: app.requireRole('marketing_manager') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const repo = new TemplatesRepo(app.db);

      const template = await repo.findById(id);
      if (!template) {
        return reply.status(404).send({ error: 'Not found' });
      }

      if (template.status === 'disabled') {
        return reply.status(400).send({ error: 'Template is already disabled' });
      }

      const neverActivated = template.active_version === null;
      const updated = await repo.disable(id);
      templateCache.evict(id);

      if (neverActivated) {
        return reply.status(200).send({ ...updated, warning: 'Template has no active version; it was never activated' });
      }
      return reply.status(200).send(updated);
    },
  );

  app.post(
    '/templates/:id/activate',
    { schema: { tags: ['Templates'], summary: 'Activate template version' } as object, preHandler: app.requireRole('marketing_manager') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const repo = new TemplatesRepo(app.db);

      const template = await repo.findById(id);
      if (!template) {
        return reply.status(404).send({ error: 'Not found' });
      }

      const updated = await repo.activate(id);
      templateCache.evict(id);
      return reply.status(200).send(updated);
    },
  );

  app.patch(
    '/templates/:id',
    {
      schema: {
        tags: ['Templates'],
        summary: 'Update template',
        body: Type.Object({
          name: Type.Optional(Type.String()),
          body_text: Type.Optional(Type.String()),
          subject: Type.Optional(Type.String()),
          body_html: Type.Optional(Type.String()),
          body_unlayer: Type.Optional(Type.Object({}, { additionalProperties: true })),
        }),
      } as object,
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        name?: string;
        body_text?: string;
        subject?: string;
        body_html?: string;
        body_unlayer?: Record<string, unknown>;
      };

      const repo = new TemplatesRepo(app.db);

      const template = await repo.findById(id);
      if (!template) {
        return reply.status(404).send({ error: 'Not found' });
      }

      // Channel-immutable field filtering: SMS drops email-only fields
      const contentPayload: {
        body_text?: string;
        subject?: string;
        body_html?: string;
        body_unlayer?: Record<string, unknown>;
      } = {};

      if ('body_text' in body) contentPayload.body_text = body.body_text;

      if (template.channel === 'email') {
        if ('subject' in body) contentPayload.subject = body.subject;
        if ('body_html' in body) contentPayload.body_html = body.body_html;
        if ('body_unlayer' in body) contentPayload.body_unlayer = body.body_unlayer;
      }

      // Content-length validation
      if (body.name !== undefined && body.name.length > 255) {
        return reply.status(400).send({ error: 'name exceeds 255 character limit' });
      }
      if (contentPayload.body_text !== undefined) {
        if (template.channel === 'sms' && contentPayload.body_text.length > 1600) {
          return reply.status(400).send({ error: 'body_text exceeds 1600 character limit for SMS templates' });
        }
        if (template.channel === 'email' && contentPayload.body_text.length > 10000) {
          return reply.status(400).send({ error: 'body_text exceeds 10000 character limit for email templates' });
        }
      }
      if (contentPayload.subject !== undefined && contentPayload.subject.length > 500) {
        return reply.status(400).send({ error: 'subject exceeds 500 character limit' });
      }
      if (contentPayload.body_html !== undefined && contentPayload.body_html.length > 500000) {
        return reply.status(400).send({ error: 'body_html exceeds 500000 character limit' });
      }

      const hasContentFields = Object.keys(contentPayload).length > 0;

      let created_by: string | null = null;
      if (!isServiceApiKey(request.headers.authorization)) {
        const claims = await verifyJwt(request.headers.authorization, app.jwtSecret);
        created_by = claims.sub;
      }

      try {
        let updatedTemplate: TemplateRow;

        if (!hasContentFields) {
          // Only name update — skip version operation
          updatedTemplate = await repo.updateTemplateGroup(id, {
            ...(body.name !== undefined ? { name: body.name } : {}),
          });
        } else if (template.active_version === null) {
          // Branch 1: no active version — update draft version in place
          await repo.updateVersionInPlace(id, template.current_version, contentPayload);
          updatedTemplate = await repo.updateTemplateGroup(id, {
            ...(body.name !== undefined ? { name: body.name } : {}),
          });
        } else if (template.current_version === template.active_version) {
          // Branch 2: draft == active — create new draft version atomically
          const newVersion = template.current_version + 1;
          await app.db.transaction(async (trx) => {
            const trxRepo = new TemplatesRepo(trx);
            await trxRepo.insertNewVersion({
              template_id: id,
              version: newVersion,
              body_text: contentPayload.body_text ?? null,
              subject: contentPayload.subject ?? null,
              body_html: contentPayload.body_html ?? null,
              body_unlayer: contentPayload.body_unlayer ?? null,
              created_by,
            });
            await trxRepo.updateTemplateGroup(id, {
              current_version: newVersion,
              ...(body.name !== undefined ? { name: body.name } : {}),
            });
          });
          const refreshed = await repo.findById(id);
          updatedTemplate = refreshed!;
        } else {
          // Branch 3: draft > active — update draft version in place
          await repo.updateVersionInPlace(id, template.current_version, contentPayload);
          updatedTemplate = await repo.updateTemplateGroup(id, {
            ...(body.name !== undefined ? { name: body.name } : {}),
          });
        }

        const draftVersion = await repo.findVersionContent(id, updatedTemplate.current_version);
        const draftContent = draftVersion
          ? {
              version: draftVersion.version,
              body_text: draftVersion.body_text,
              subject: draftVersion.subject,
              body_html: draftVersion.body_html,
              body_unlayer: draftVersion.body_unlayer,
            }
          : null;

        return reply.status(200).send({ ...updatedTemplate, draft_content: draftContent });
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e.code === '23505') {
          return reply.status(409).send({ error: 'Template name already exists' });
        }
        throw err;
      }
    },
  );
}
