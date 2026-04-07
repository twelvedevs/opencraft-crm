import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import type { EventBus } from '@ortho/event-bus';

export async function membershipRoutes(
  app: FastifyInstance,
  opts: { db: Knex; eventBus: EventBus },
): Promise<void> {
  app.post('/memberships', async (_req, reply) => {
    reply.status(501).send({ error: 'not_implemented' });
  });
}
