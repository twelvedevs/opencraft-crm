import { type FastifyInstance } from 'fastify';
import { requirePermission } from '@ortho/auth-middleware';
import { getMetrics } from '../../services/metrics-cache.js';
import { MetricsQueryParams } from '../../schemas/metrics.js';
import { parsePeriod, isPeriodError } from '../../services/period.js';
import { resolveLocationIds } from '../dashboard.js';

const readPerm = requirePermission('reporting:read');

export async function campaignAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /reporting/metrics/campaign-analytics
   *
   * Returns per-campaign send/deliver/open/click/conversion counts.
   */
  app.get(
    '/reporting/metrics/campaign-analytics',
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

      const location_ids = resolveLocationIds(
        req.user!.role,
        req.user!.locations,
        queryLocIds,
      );

      try {
        const metrics = await getMetrics('campaign-analytics', {
          period: `${periodResult.from}/${periodResult.to}`,
          location_ids,
          granularity: q.granularity,
        });

        const campaigns = metrics.raw.campaigns.campaigns.map(c => {
          const conversion_rate = c.sent === 0 ? null : c.conversions / c.sent;
          return {
            campaign_id: c.campaign_id,
            campaign_name: c.campaign_name,
            sent: c.sent,
            delivered: c.delivered,
            opened: c.opened,
            clicked: c.clicked,
            conversions: c.conversions,
            conversion_rate,
          };
        });

        return reply.code(200).send({
          period: periodResult.label,
          campaigns,
        });
      } catch (err) {
        req.log.error({ err }, 'Analytics Service error on campaign-analytics');
        return reply.code(502).send({
          error: 'upstream_unavailable',
          upstream: 'analytics',
        });
      }
    },
  );
}
