import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { TemplatesRepo } from '../repositories/templates.js';
import { templateCache } from '../services/template-cache.js';
import { renderString } from '../services/template-renderer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function renderRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.requireAuth());

  app.post(
    '/templates/render',
    {
      schema: {
        tags: ['Render'],
        summary: 'Render template with merge tags',
        body: Type.Object({
          template_id: Type.String(),
          context: Type.Record(Type.String(), Type.Unknown()),
        }),
      } as object,
    },
    async (request, reply) => {
      const { template_id, context } = request.body as {
        template_id: string;
        context: Record<string, unknown>;
      };

      if (!UUID_RE.test(template_id)) {
        return reply.status(400).send({ error: 'template_id must be a valid UUID' });
      }

      const repo = new TemplatesRepo(app.db);

      let content = templateCache.get(template_id);

      if (!content) {
        const dbContent = await repo.findActiveVersionContent(template_id);
        if (!dbContent) {
          return reply.status(404).send({ error: 'Template not found or not renderable' });
        }
        templateCache.set(template_id, dbContent);
        content = dbContent;
      }

      if (content.channel === 'sms') {
        const result = renderString(content.body_text ?? '', context);
        if (!result.ok) {
          return reply.status(400).send({ error: result.error });
        }
        if (result.warnings.length > 0) {
          request.log.warn(
            { warnings: result.warnings, template_id },
            'merge tag resolution warnings',
          );
        }
        return reply.status(200).send({ channel: 'sms', body_text: result.value });
      }

      // email
      const subjectResult = renderString(content.subject ?? '', context);
      const htmlResult = renderString(content.body_html ?? '', context);
      const textResult = renderString(content.body_text ?? '', context);

      if (!subjectResult.ok) return reply.status(400).send({ error: subjectResult.error });
      if (!htmlResult.ok) return reply.status(400).send({ error: htmlResult.error });
      if (!textResult.ok) return reply.status(400).send({ error: textResult.error });

      const allWarnings = [
        ...subjectResult.warnings,
        ...htmlResult.warnings,
        ...textResult.warnings,
      ];
      if (allWarnings.length > 0) {
        request.log.warn(
          { warnings: allWarnings, template_id },
          'merge tag resolution warnings',
        );
      }

      return reply.status(200).send({
        channel: 'email',
        subject: subjectResult.value,
        body_html: htmlResult.value,
        body_text: textResult.value,
      });
    },
  );
}
