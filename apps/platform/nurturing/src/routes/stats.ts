import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsync } from 'fastify';
import type { SequenceDefinitionsRepository } from '../repositories/sequence-definitions.repo.js';
import type { SequenceVersionsRepository } from '../repositories/sequence-versions.repo.js';
import type { EnrollmentsRepository } from '../repositories/enrollments.repo.js';
import { computeAbSignificance } from '../services/ab-significance.js';

export interface StatsRouteOptions {
  definitionsRepo: SequenceDefinitionsRepository;
  versionsRepo: SequenceVersionsRepository;
  enrollmentsRepo: EnrollmentsRepository;
}

const ParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

const statsRoutes: FastifyPluginAsync<StatsRouteOptions> = async (fastify, opts) => {
  const { definitionsRepo, versionsRepo, enrollmentsRepo } = opts;

  fastify.get(
    '/sequences/:id/stats',
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: ParamsSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const def = await definitionsRepo.findById(id);
      if (!def) {
        return reply.code(404).send({ error: 'sequence_not_found' });
      }

      const counts = await enrollmentsRepo.getEnrollmentCounts(id);
      const total = counts.total;

      const completion_rate =
        total === 0 ? 0 : Math.round((counts.completed / total) * 1000) / 1000;
      const unenrollment_rate =
        total === 0 ? 0 : Math.round((counts.unenrolled / total) * 1000) / 1000;

      // Check if A/B test is configured on the active version
      let abBlock: unknown = null;
      if (def.active_version != null) {
        const activeVersionRow = await versionsRepo.findBySequenceAndVersion(
          id,
          def.active_version,
        );
        const abTest = activeVersionRow?.ab_test as { enabled?: boolean } | null | undefined;
        if (abTest && abTest.enabled === true) {
          const breakdown = await enrollmentsRepo.getAbBreakdown(id);
          const variantA = breakdown.find((v) => v.ab_variant === 'A');
          const variantB = breakdown.find((v) => v.ab_variant === 'B');

          const aEnrollments = variantA?.enrollments ?? 0;
          const bEnrollments = variantB?.enrollments ?? 0;
          const aCompletions = variantA?.completions ?? 0;
          const bCompletions = variantB?.completions ?? 0;
          const aConversions = variantA?.conversions ?? 0;
          const bConversions = variantB?.conversions ?? 0;

          const significance = computeAbSignificance(
            { enrollments: aEnrollments, conversions: aConversions },
            { enrollments: bEnrollments, conversions: bConversions },
            'A',
            'B',
          );

          abBlock = {
            A: {
              enrollments: aEnrollments,
              completions: aCompletions,
              conversions: aConversions,
              completion_rate:
                aEnrollments === 0
                  ? 0
                  : Math.round((aCompletions / aEnrollments) * 1000) / 1000,
              conversion_rate:
                aEnrollments === 0
                  ? 0
                  : Math.round((aConversions / aEnrollments) * 1000) / 1000,
            },
            B: {
              enrollments: bEnrollments,
              completions: bCompletions,
              conversions: bConversions,
              completion_rate:
                bEnrollments === 0
                  ? 0
                  : Math.round((bCompletions / bEnrollments) * 1000) / 1000,
              conversion_rate:
                bEnrollments === 0
                  ? 0
                  : Math.round((bConversions / bEnrollments) * 1000) / 1000,
            },
            winner: significance.winner,
            significant: significance.significant,
            p_value: significance.p_value,
          };
        }
      }

      return reply.send({
        sequence_id: id,
        total_enrollments: total,
        completed_count: counts.completed,
        unenrolled_count: counts.unenrolled,
        failed_count: counts.failed,
        active_count: counts.active,
        completion_rate,
        unenrollment_rate,
        ab: abBlock,
      });
    },
  );
};

export default statsRoutes;
