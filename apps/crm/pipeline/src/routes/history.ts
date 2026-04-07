import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import type { EventBus } from '@ortho/event-bus';
import { findById } from '../repositories/membership.repo.js';
import { findByMembershipId } from '../repositories/stage-history.repo.js';

export async function historyRoutes(
  app: FastifyInstance,
  opts: { db: Knex; eventBus: EventBus },
): Promise<void> {
  const { db } = opts;

  app.get('/memberships/:id/history', async (req, reply) => {
    const { id } = req.params as { id: string };

    const membership = await findById(db, id);
    if (!membership) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const history = await findByMembershipId(db, id);
    return reply.status(200).send(history);
  });
}
