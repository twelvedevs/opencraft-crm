import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import type { EventBus } from '@ortho/event-bus';
import { computeTimeoutAt, STAGES } from '../services/state-machine.js';
import {
  findActiveByLeadAndPipeline,
  createMembership,
  findById,
  listMemberships,
} from '../repositories/membership.repo.js';
import { insertHistory } from '../repositories/stage-history.repo.js';
import { publishStageChanged } from '../events/publisher.js';

const ListQuerySchema = Type.Object({
  lead_id: Type.Optional(Type.String()),
  pipeline: Type.Optional(Type.String()),
  stage: Type.Optional(Type.String()),
  location_id: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

const EnrollBodySchema = Type.Object({
  lead_id: Type.String({ format: 'uuid' }),
  location_id: Type.String({ format: 'uuid' }),
  pipeline: Type.Union([
    Type.Literal('new_patient'),
    Type.Literal('in_treatment'),
    Type.Literal('in_retention'),
  ]),
  stage: Type.String(),
  triggered_by: Type.Optional(Type.Union([Type.String({ format: 'uuid' }), Type.Null()])),
  reason: Type.Union([Type.Literal('manual'), Type.Literal('import')]),
  timeout_at: Type.Optional(Type.String()),
});

export async function membershipRoutes(
  app: FastifyInstance,
  opts: { db: Knex; eventBus: EventBus },
): Promise<void> {
  const { db, eventBus } = opts;

  app.post('/memberships', { schema: { body: EnrollBodySchema } }, async (req, reply) => {
    const body = req.body as {
      lead_id: string;
      location_id: string;
      pipeline: string;
      stage: string;
      triggered_by?: string | null;
      reason: string;
      timeout_at?: string;
    };

    // Validate recall_due requires timeout_at
    if (body.stage === 'recall_due' && !body.timeout_at) {
      return reply.status(400).send({ error: 'timeout_at_required' });
    }

    // Check for existing active membership
    const existing = await findActiveByLeadAndPipeline(db, body.lead_id, body.pipeline);
    if (existing) {
      return reply.status(409).send({ error: 'membership_already_active' });
    }

    const callerTimeoutAt = body.timeout_at ? new Date(body.timeout_at) : undefined;
    const now = new Date();
    const timeoutAt = computeTimeoutAt(body.stage, now, callerTimeoutAt);

    // Transaction: create membership + insert history
    const membership = await db.transaction(async (trx) => {
      const created = await createMembership(trx, {
        lead_id: body.lead_id,
        location_id: body.location_id,
        pipeline: body.pipeline,
        stage: body.stage,
        triggered_by: body.triggered_by ?? null,
        timeout_at: timeoutAt,
        reason: body.reason,
      });

      await insertHistory(trx, {
        membership_id: created.id,
        lead_id: body.lead_id,
        pipeline: body.pipeline,
        stage_from: null,
        stage_to: body.stage,
        override: false,
        triggered_by: body.triggered_by ?? null,
        reason: body.reason,
      });

      return created;
    });

    // Publish after commit
    const correlationId = (req.headers['x-correlation-id'] as string) ?? randomUUID();
    await publishStageChanged(eventBus, correlationId, {
      membership_id: membership.id,
      lead_id: membership.lead_id,
      location_id: membership.location_id,
      pipeline: membership.pipeline,
      stage_from: null,
      stage_to: membership.stage,
      override: false,
      triggered_by: body.triggered_by ?? null,
      reason: body.reason,
      timeout_at: membership.timeout_at ? membership.timeout_at.toISOString() : null,
      transitioned_at: membership.entered_stage_at.toISOString(),
      time_in_stage_seconds: null,
      response_time_seconds: null,
    });

    return reply.status(201).send(membership);
  });

  app.get('/memberships', { schema: { querystring: ListQuerySchema } }, async (req, reply) => {
    const query = req.query as {
      lead_id?: string;
      pipeline?: string;
      stage?: string;
      location_id?: string;
      status?: string;
      cursor?: string;
      limit?: number;
    };

    const result = await listMemberships(db, {
      lead_id: query.lead_id,
      pipeline: query.pipeline,
      stage: query.stage,
      location_id: query.location_id,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });

    return reply.status(200).send(result);
  });

  app.get('/memberships/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const membership = await findById(db, id);
    if (!membership) {
      return reply.status(404).send({ error: 'not_found' });
    }
    return reply.status(200).send(membership);
  });
}
