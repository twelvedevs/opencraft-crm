import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import type { EventBus } from '@ortho/event-bus';
import { findById, setStatus } from '../repositories/membership.repo.js';

const CloseBodySchema = Type.Object({
  triggered_by: Type.String({ minLength: 1 }),
  closed_reason: Type.Literal('import_undo'),
});

export async function closeRoutes(
  app: FastifyInstance,
  opts: { db: Knex; eventBus: EventBus },
): Promise<void> {
  const { db } = opts;

  app.post(
    '/memberships/:id/close',
    { schema: { body: CloseBodySchema } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as { triggered_by: string; closed_reason: string };

      const membership = await findById(db, id);
      if (!membership) {
        return reply.status(404).send({ error: 'not_found' });
      }

      if (membership.status !== 'active') {
        return reply.status(409).send({ error: 'membership_not_active' });
      }

      const updated = await setStatus(db, id, {
        status: 'closed',
        closed_reason: body.closed_reason,
        closed_at: new Date(),
      });

      return reply.status(200).send(updated);
    },
  );
}
