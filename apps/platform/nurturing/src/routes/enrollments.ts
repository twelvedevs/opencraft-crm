import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsync } from 'fastify';
import type { Queue } from 'bullmq';
import type { Knex } from 'knex';
import type { EnrollmentManager } from '../services/enrollment-manager.js';
import type { EnrollmentsRepository } from '../repositories/enrollments.repo.js';
import type { StepExecutionsRepository } from '../repositories/step-executions.repo.js';
import type { NurturingPublisher } from '../events/publisher.js';
import type { StepJobData } from '../queue/step-queue.js';
import { unenroll } from '../services/unenrollment.js';

export interface EnrollmentsRouteOptions {
  enrollmentManager: EnrollmentManager;
  enrollmentsRepo: EnrollmentsRepository;
  stepExecutionsRepo: StepExecutionsRepository;
  db: Knex;
  stepQueue: Queue<StepJobData> | null;
  publisher: NurturingPublisher | null;
}

const UnenrollBodySchema = Type.Object({
  sequence_id: Type.String({ format: 'uuid' }),
  entity_type: Type.String({ minLength: 1 }),
  entity_id: Type.String({ minLength: 1 }),
});

const EnrollBodySchema = Type.Object({
  sequence_id: Type.String({ format: 'uuid' }),
  entity_type: Type.String({ minLength: 1 }),
  entity_id: Type.String({ minLength: 1 }),
  context: Type.Record(Type.String(), Type.Unknown()),
  dedup_key: Type.String({ minLength: 1 }),
});

const EnrollmentParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

const EnrollmentDetailParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  eid: Type.String({ format: 'uuid' }),
});

const StepParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  eid: Type.String({ format: 'uuid' }),
  sid: Type.String(),
});

const EnrollmentsQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  cursor: Type.Optional(Type.String()),
});

const enrollmentsRoutes: FastifyPluginAsync<EnrollmentsRouteOptions> = async (fastify, opts) => {
  fastify.get(
    '/sequences/:id/enrollments',
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: EnrollmentParamsSchema,
        querystring: EnrollmentsQuerySchema,
      },
    },
    async (request, reply) => {
      const params = request.params as { id: string };
      const query = request.query as { limit?: number; cursor?: string };
      const limit = query.limit ?? 20;

      const enrollments = await opts.enrollmentsRepo.findBySequenceId(params.id, {
        limit,
        cursor: query.cursor,
      });

      return reply.code(200).send(
        enrollments.map((e) => ({
          id: e.id,
          sequence_id: e.sequence_id,
          entity_type: e.entity_type,
          entity_id: e.entity_id,
          status: e.status,
          ab_variant: e.ab_variant,
          enrolled_at: e.enrolled_at,
          completed_at: e.completed_at,
        })),
      );
    },
  );

  fastify.get(
    '/sequences/:id/enrollments/:eid',
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: EnrollmentDetailParamsSchema,
      },
    },
    async (request, reply) => {
      const params = request.params as { id: string; eid: string };

      const enrollment = await opts.enrollmentsRepo.findById(params.eid);
      if (enrollment === null) {
        return reply.code(404).send({ error: 'enrollment_not_found' });
      }

      const steps = await opts.stepExecutionsRepo.findByEnrollmentId(params.eid);

      return reply.code(200).send({
        id: enrollment.id,
        sequence_id: enrollment.sequence_id,
        entity_type: enrollment.entity_type,
        entity_id: enrollment.entity_id,
        status: enrollment.status,
        ab_variant: enrollment.ab_variant,
        enrolled_at: enrollment.enrolled_at,
        completed_at: enrollment.completed_at,
        steps: steps.map((s) => ({
          id: s.id,
          step_id: s.step_id,
          step_index: s.step_index,
          scheduled_at: s.scheduled_at,
          status: s.status,
          attempt: s.attempt,
          output: s.output,
          error: s.error,
          started_at: s.started_at,
          completed_at: s.completed_at,
        })),
      });
    },
  );

  fastify.get(
    '/sequences/:id/enrollments/:eid/steps/:sid',
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: StepParamsSchema,
      },
    },
    async (request, reply) => {
      const params = request.params as { id: string; eid: string; sid: string };

      const s = await opts.stepExecutionsRepo.findByEnrollmentAndStepId(params.eid, params.sid);
      if (s === null) {
        return reply.code(404).send({ error: 'step_not_found' });
      }

      return reply.code(200).send({
        step_id: s.step_id,
        status: s.status,
        output: s.output,
        error: s.error,
        completed_at: s.completed_at,
      });
    },
  );

  fastify.post(
    '/sequences/enroll',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: EnrollBodySchema,
      },
    },
    async (request, reply) => {
      const body = request.body as {
        sequence_id: string;
        entity_type: string;
        entity_id: string;
        context: Record<string, unknown>;
        dedup_key: string;
      };

      try {
        const result = await opts.enrollmentManager.enroll(body);

        if (result.already_enrolled === true) {
          return reply.code(200).send({ enrollment_id: result.enrollment_id, already_enrolled: true });
        }

        return reply.code(201).send({ enrollment_id: result.enrollment_id });
      } catch (err) {
        const e = err as { code?: string };
        if (e.code === 'sequence_not_found') {
          return reply.code(404).send({ error: 'sequence_not_found' });
        }
        if (e.code === 'sequence_disabled') {
          return reply.code(422).send({ error: 'sequence_disabled' });
        }
        if (e.code === 'sequence_not_active') {
          return reply.code(422).send({ error: 'sequence_not_active' });
        }
        throw err;
      }
    },
  );
  fastify.post(
    '/sequences/unenroll',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: UnenrollBodySchema,
      },
    },
    async (request, reply) => {
      const body = request.body as {
        sequence_id: string;
        entity_type: string;
        entity_id: string;
      };

      await unenroll(
        { sequence_id: body.sequence_id, entity_type: body.entity_type, entity_id: body.entity_id },
        {
          db: opts.db,
          enrollmentsRepo: opts.enrollmentsRepo,
          stepExecutionsRepo: opts.stepExecutionsRepo,
          stepQueue: opts.stepQueue as Queue<StepJobData>,
          publisher: opts.publisher as NurturingPublisher,
        },
      );

      return reply.code(200).send({ ok: true });
    },
  );
};

export default enrollmentsRoutes;
