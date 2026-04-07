import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import type { EventBus } from '@ortho/event-bus';
import { applyTransition, TransitionError } from '../services/transition.service.js';

const TransitionBodySchema = Type.Object({
  stage: Type.String(),
  override: Type.Boolean({ default: false }),
  triggered_by: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  reason: Type.Union([
    Type.Literal('manual'),
    Type.Literal('timeout'),
    Type.Literal('no_show'),
    Type.Literal('import'),
    Type.Literal('import_undo'),
  ]),
  timeout_at: Type.Optional(Type.String()),
});

export async function transitionRoutes(
  app: FastifyInstance,
  opts: { db: Knex; eventBus: EventBus },
): Promise<void> {
  const { db, eventBus } = opts;

  app.post(
    '/memberships/:id/transition',
    { schema: { body: TransitionBodySchema } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as {
        stage: string;
        override: boolean;
        triggered_by?: string | null;
        reason: string;
        timeout_at?: string;
      };

      const correlationId = (req.headers['x-correlation-id'] as string) ?? randomUUID();

      try {
        const membership = await applyTransition(db, eventBus, id, body, correlationId);
        return reply.status(200).send(membership);
      } catch (err) {
        if (err instanceof TransitionError) {
          return reply.status(err.statusCode).send(err.body);
        }
        throw err;
      }
    },
  );
}
