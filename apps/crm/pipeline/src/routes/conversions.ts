import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import type { EventBus } from '@ortho/event-bus';
import { applyConversion, ConversionError } from '../services/convert.service.js';

const ConvertBodySchema = Type.Object({
  to_pipeline: Type.Union([Type.Literal('in_treatment'), Type.Literal('in_retention')]),
  to_stage: Type.String(),
  triggered_by: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  reason: Type.Literal('converted'),
  channel: Type.Union([
    Type.Literal('google_ads'),
    Type.Literal('facebook'),
    Type.Literal('website'),
    Type.Literal('referral_patient'),
    Type.Literal('referral_doctor'),
    Type.Literal('call_tracking'),
    Type.Literal('walk_in'),
    Type.Literal('chat'),
    Type.Literal('google_business'),
    Type.Literal('import'),
    Type.Literal('unknown'),
  ]),
});

export async function conversionRoutes(
  app: FastifyInstance,
  opts: { db: Knex; eventBus: EventBus },
): Promise<void> {
  const { db, eventBus } = opts;

  app.post(
    '/memberships/:id/convert',
    { schema: { body: ConvertBodySchema } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as {
        to_pipeline: 'in_treatment' | 'in_retention';
        to_stage: string;
        triggered_by?: string | null;
        reason: 'converted';
        channel: string;
      };

      const correlationId = (req.headers['x-correlation-id'] as string) ?? randomUUID();

      try {
        const membership = await applyConversion(db, eventBus, id, body, correlationId);
        return reply.status(201).send(membership);
      } catch (err) {
        if (err instanceof ConversionError) {
          return reply.status(err.statusCode).send(err.body);
        }
        throw err;
      }
    },
  );
}
