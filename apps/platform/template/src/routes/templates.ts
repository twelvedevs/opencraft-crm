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
}
