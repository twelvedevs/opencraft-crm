import { type FastifyInstance } from 'fastify';
import { requirePermission } from '@ortho/auth-middleware';
import { getMetrics } from '../services/metrics-cache.js';
import { MetricsQueryParams } from '../schemas/metrics.js';
import { parsePeriod, isPeriodError } from '../services/period.js';

const readPerm = requirePermission('reporting:read');

/**
 * Resolve which location_ids to pass to the analytics layer based on the
 * caller's role and the optional query-string location_id[] parameter.
 *
 * - call_center_agent   → always restricted to their own location(s) from JWT
 * - call_center_manager → their JWT locations; query param not respected
 * - marketing_staff / marketing_manager → undefined (all-location access)
 *
 * When the result is undefined, analytics-client omits location_id from the
 * request, triggering an all-location aggregation.
 */
export function resolveLocationIds(
  role: string,
  jwtLocations: string[],
  queryLocationIds?: string[],
): string[] | undefined {
  if (role === 'call_center_agent' || role === 'call_center_manager') {
    // Scoped roles: always use the JWT locations; ignore caller-supplied filter
    // to prevent privilege escalation.
    return jwtLocations.length > 0 ? jwtLocations : undefined;
  }
  // marketing_staff / marketing_manager / super_admin
  // Optionally filter to the location_ids passed in the query, but default to
  // all locations (undefined).
  if (queryLocationIds && queryLocationIds.length > 0) {
    return queryLocationIds;
  }
  return undefined;
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /reporting/dashboard
   *
   * Query params:
   *   period       — YYYY-MM or YYYY-MM-DD/YYYY-MM-DD (required)
   *   location_id  — repeatable string (optional, respected for marketing roles)
   *   granularity  — daily | monthly | total (optional)
   */
  app.get(
    '/reporting/dashboard',
    {
      schema: { querystring: MetricsQueryParams, tags: ['Dashboard'], summary: 'Get executive dashboard summary' },
      preHandler: [readPerm],
    },
    async (req, reply) => {
      const q = req.query as {
        period: string;
        location_id?: string | string[];
        granularity?: string;
      };

      // Normalise location_id → string[]
      const queryLocIds = q.location_id
        ? Array.isArray(q.location_id)
          ? q.location_id
          : [q.location_id]
        : undefined;

      const periodResult = parsePeriod(q.period);
      if (isPeriodError(periodResult)) {
        return reply.code(400).send(periodResult);
      }

      const location_ids = resolveLocationIds(
        req.user!.role,
        req.user!.locations,
        queryLocIds,
      );

      try {
        const metrics = await getMetrics('dashboard', {
          period: `${periodResult.from}/${periodResult.to}`,
          location_ids,
          granularity: q.granularity,
        });

        return reply.code(200).send({
          period: periodResult.label,
          granularity: q.granularity,
          kpis: {
            cost_per_lead: metrics.cost_per_lead,
            exam_conversion_rate: metrics.exam_conversion_rate,
            exam_show_rate: metrics.exam_show_rate,
            case_conversion_rate: metrics.case_conversion_rate,
            cost_per_exam: metrics.cost_per_exam,
            cost_per_case_start: metrics.cost_per_case_start,
            revenue_attributed: metrics.revenue_attributed,
            roas: metrics.roas,
            lead_response_time: metrics.lead_response_time,
            time_in_stage: metrics.time_in_stage,
          },
          missing_revenue_config: metrics.missing_revenue_config,
        });
      } catch (err) {
        req.log.error({ err }, 'Analytics Service error on dashboard');
        return reply.code(502).send({
          error: 'upstream_unavailable',
          upstream: 'analytics',
        });
      }
    },
  );
}
