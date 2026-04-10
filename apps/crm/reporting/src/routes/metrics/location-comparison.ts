import { type FastifyInstance } from 'fastify';
import { requirePermission } from '@ortho/auth-middleware';
import { getMetrics } from '../../services/metrics-cache.js';
import { MetricsQueryParams } from '../../schemas/metrics.js';
import { parsePeriod, isPeriodError } from '../../services/period.js';
import { type ComputedMetrics } from '../../services/metrics-calculator.js';

const readPerm = requirePermission('reporting:read');

function buildLocationKpis(locationId: string, m: ComputedMetrics) {
  return {
    location_id: locationId,
    leads: m.raw.leads.total,
    cost_per_lead: m.cost_per_lead,
    exam_conversion_rate: m.exam_conversion_rate,
    case_conversion_rate: m.case_conversion_rate,
    cost_per_case_start: m.cost_per_case_start,
    revenue_attributed: m.revenue_attributed,
    roas: m.roas,
  };
}

export async function locationComparisonRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /reporting/metrics/location-comparison
   *
   * Returns per-location KPIs and (for marketing roles) a network_average entry.
   *
   * Per spec Section 4.3:
   * - call_center_agent / call_center_manager → network_average: null, no extra call
   * - marketing_staff / marketing_manager → fire all per-location calls AND an
   *   all-locations call in parallel; merge results to produce network_average
   */
  app.get(
    '/reporting/metrics/location-comparison',
    {
      schema: { querystring: MetricsQueryParams },
      preHandler: [readPerm],
    },
    async (req, reply) => {
      const q = req.query as {
        period: string;
        location_id?: string | string[];
        granularity?: string;
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
      const jwtLocations = req.user!.locations;

      // Determine which locations to show per-location breakdown for
      const isMarketingRole =
        role === 'marketing_staff' || role === 'marketing_manager' || role === 'super_admin';

      // For marketing roles, targetLocations is driven exclusively by the caller's
      // query params. When no location_id[] is supplied, the per-location breakdown
      // is empty (we cannot enumerate all location IDs) — the response will contain
      // locations:[] with a valid network_average. This is intentional: callers who
      // want a per-location breakdown must pass the location_id[] filter explicitly.
      const targetLocations: string[] = isMarketingRole
        ? (queryLocIds ?? [])
        : jwtLocations;

      const analyticsParams = {
        period: `${periodResult.from}/${periodResult.to}`,
        granularity: q.granularity,
      };

      try {
        if (isMarketingRole) {
          // Fire per-location calls + all-location call in parallel (spec Section 4.3)
          const perLocationPromises = targetLocations.map(locId =>
            getMetrics(`location:${locId}`, {
              ...analyticsParams,
              location_ids: [locId],
            }).then(m => buildLocationKpis(locId, m)),
          );

          const networkPromise = getMetrics('location:network', {
            ...analyticsParams,
            location_ids: undefined,
          });

          const [locationResults, networkMetrics] = await Promise.all([
            Promise.all(perLocationPromises),
            networkPromise,
          ]);

          const network_average =
            networkMetrics
              ? buildLocationKpis('_network', networkMetrics)
              : null;

          const networkMissing = networkMetrics?.missing_revenue_config ?? [];

          return reply.code(200).send({
            period: periodResult.label,
            locations: locationResults,
            network_average,
            missing_revenue_config: networkMissing,
          });
        } else {
          // Scoped roles: per-location calls only, no network_average
          const perLocationPromises = targetLocations.map(locId =>
            getMetrics(`location:${locId}`, {
              ...analyticsParams,
              location_ids: [locId],
            }).then(m => buildLocationKpis(locId, m)),
          );

          const locationResults = await Promise.all(perLocationPromises);

          return reply.code(200).send({
            period: periodResult.label,
            locations: locationResults,
            network_average: null,
            missing_revenue_config: [],
          });
        }
      } catch (err) {
        req.log.error({ err }, 'Analytics Service error on location-comparison');
        return reply.code(502).send({
          error: 'upstream_unavailable',
          upstream: 'analytics',
        });
      }
    },
  );
}
