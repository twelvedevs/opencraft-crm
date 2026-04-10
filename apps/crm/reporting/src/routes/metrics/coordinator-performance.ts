import { type FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { requirePermission } from '@ortho/auth-middleware';
import { getMetrics } from '../../services/metrics-cache.js';
import { parsePeriod, isPeriodError } from '../../services/period.js';
import { resolveLocationIds } from '../dashboard.js';

const readPerm = requirePermission('reporting:read');

const CoordinatorQueryParams = Type.Object({
  period: Type.String({ pattern: '^\\d{4}-\\d{2}$|^\\d{4}-\\d{2}-\\d{2}/\\d{4}-\\d{2}-\\d{2}$' }),
  location_id: Type.Optional(Type.Array(Type.String())),
  granularity: Type.Optional(
    Type.Union([
      Type.Literal('daily'),
      Type.Literal('monthly'),
      Type.Literal('total'),
    ]),
  ),
  coordinator_id: Type.Optional(Type.String()),
});

export async function coordinatorPerformanceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /reporting/metrics/coordinator-performance
   *
   * Query params:
   *   period          — YYYY-MM or YYYY-MM-DD/YYYY-MM-DD (required)
   *   coordinator_id  — optional; call_center_agent: always overwritten with req.user.sub
   *   location_id[]   — optional location filter
   *   granularity     — optional
   */
  app.get(
    '/reporting/metrics/coordinator-performance',
    {
      schema: { querystring: CoordinatorQueryParams },
      preHandler: [readPerm],
    },
    async (req, reply) => {
      const q = req.query as {
        period: string;
        location_id?: string | string[];
        granularity?: string;
        coordinator_id?: string;
      };

      const queryLocIds = q.location_id
        ? Array.isArray(q.location_id)
          ? q.location_id
          : [q.location_id]
        : undefined;

      const periodResult = parsePeriod(q.period);
      if (isPeriodError(periodResult)) {
        return reply.code(400).send(periodResult);
      }

      const role = req.user!.role;

      // call_center_agent: always scope to own coordinator_id regardless of query param
      const coordinator_id =
        role === 'call_center_agent' ? req.user!.sub : q.coordinator_id;

      const location_ids = resolveLocationIds(role, req.user!.locations, queryLocIds);

      const analyticsParams = {
        period: `${periodResult.from}/${periodResult.to}`,
        location_ids,
        granularity: q.granularity,
        ...(coordinator_id !== undefined ? { coordinator_id } : {}),
      };

      try {
        // Include coordinator_id in the cache family to prevent different coordinator
        // filters from colliding on the same cache entry.
        const cacheFamily = coordinator_id
          ? `coordinator-performance:${coordinator_id}`
          : 'coordinator-performance';
        const metrics = await getMetrics(cacheFamily, analyticsParams);

        const coordinators = metrics.raw.coordinators.coordinators.map(c => ({
          coordinator_id: c.coordinator_id,
          stage_transitions: c.stage_transitions,
          exams_booked: c.exams_booked,
          conversions: c.conversions,
          avg_response_time_seconds: c.avg_response_time_seconds,
          avg_time_in_stage_seconds: c.avg_time_in_stage_seconds,
        }));

        return reply.code(200).send({
          period: periodResult.label,
          coordinators,
        });
      } catch (err) {
        req.log.error({ err }, 'Analytics Service error on coordinator-performance');
        return reply.code(502).send({
          error: 'upstream_unavailable',
          upstream: 'analytics',
        });
      }
    },
  );
}
