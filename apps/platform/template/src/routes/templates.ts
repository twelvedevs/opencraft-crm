import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { TemplatesRepo } from '../repositories/templates.js';
import { isServiceApiKey, verifyJwt } from '../plugins/auth.js';

export default async function templateRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.requireRole('marketing_staff'));

  app.post(
    '/templates',
    {
      schema: {
        body: Type.Object({
          name: Type.String(),
          channel: Type.Union([Type.Literal('sms'), Type.Literal('email')]),
        }),
      },
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
      },
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
    {},
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
}
