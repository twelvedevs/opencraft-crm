import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsync } from 'fastify';
import type { EnrollmentManager } from '../services/enrollment-manager.js';
import type { EnrollmentsRepository } from '../repositories/enrollments.repo.js';
import type { StepExecutionsRepository } from '../repositories/step-executions.repo.js';

export interface EnrollmentsRouteOptions {
  enrollmentManager: EnrollmentManager;
  enrollmentsRepo: EnrollmentsRepository;
  stepExecutionsRepo: StepExecutionsRepository;
}

const EnrollBodySchema = Type.Object({
  sequence_id: Type.String({ format: 'uuid' }),
  entity_type: Type.String({ minLength: 1 }),
  entity_id: Type.String({ minLength: 1 }),
  context: Type.Record(Type.String(), Type.Unknown()),
  dedup_key: Type.String({ minLength: 1 }),
});

const enrollmentsRoutes: FastifyPluginAsync<EnrollmentsRouteOptions> = async (fastify, opts) => {
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
};

export default enrollmentsRoutes;
