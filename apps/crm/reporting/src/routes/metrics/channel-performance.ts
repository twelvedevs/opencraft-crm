import { type FastifyInstance } from 'fastify';
import { requirePermission } from '@ortho/auth-middleware';
import { getMetrics } from '../../services/metrics-cache.js';
import { MetricsQueryParams } from '../../schemas/metrics.js';
import { parsePeriod, isPeriodError } from '../../services/period.js';
import { resolveLocationIds } from '../dashboard.js';
import { CHANNEL_TO_PLATFORM } from '../../services/metrics-calculator.js';

const readPerm = requirePermission('reporting:read');

export async function channelPerformanceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /reporting/metrics/channel-performance
   *
   * Returns per-channel lead counts and funnel/cost KPIs.
   * Ad spend is attributed per channel using CHANNEL_TO_PLATFORM map.
   */
  app.get(
    '/reporting/metrics/channel-performance',
    {
      schema: { querystring: MetricsQueryParams, tags: ['Metrics'], summary: 'Get channel performance metrics' },
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
        const metrics = await getMetrics('channel-performance', {
          period: `${periodResult.from}/${periodResult.to}`,
          location_ids,
          granularity: q.granularity,
        });

        const raw = metrics.raw;

        // Build a map of platform → total_spend for channel attribution
        const spendByPlatform = new Map<string, number>();
        for (const p of raw.adSpend.by_platform) {
          spendByPlatform.set(p.platform, p.total_spend);
        }

        // Build per-channel funnel from pipeline stage data
        const examScheduled =
          raw.pipeline.by_stage.find(s => s.stage === 'exam_scheduled')?.entries ?? 0;
        const examCompleted =
          raw.pipeline.by_stage.find(s => s.stage === 'exam_completed')?.entries ?? 0;

        function divOrNull(n: number, d: number): number | null {
          return d === 0 ? null : n / d;
        }

        const channels = raw.leads.by_channel.map(ch => {
          const platform = CHANNEL_TO_PLATFORM[ch.channel];
          const ad_spend = platform !== undefined ? (spendByPlatform.get(platform) ?? null) : null;

          // Funnel rates use aggregate counts (no per-channel breakdown from analytics)
          const exam_conversion_rate = divOrNull(examScheduled, ch.count);
          const exam_show_rate = divOrNull(examCompleted, examScheduled);
          const case_conversion_rate = divOrNull(raw.conversions.total, examCompleted);
          const cost_per_lead = ad_spend !== null ? divOrNull(ad_spend, ch.count) : null;
          const cost_per_exam = ad_spend !== null ? divOrNull(ad_spend, examCompleted) : null;
          const cost_per_case_start =
            ad_spend !== null ? divOrNull(ad_spend, raw.conversions.total) : null;

          return {
            channel: ch.channel,
            leads: ch.count,
            exam_conversion_rate,
            exam_show_rate,
            case_conversion_rate,
            ad_spend,
            cost_per_lead,
            cost_per_exam,
            cost_per_case_start,
          };
        });

        return reply.code(200).send({
          period: periodResult.label,
          channels,
          missing_revenue_config: metrics.missing_revenue_config,
        });
      } catch (err) {
        req.log.error({ err }, 'Analytics Service error on channel-performance');
        return reply.code(502).send({
          error: 'upstream_unavailable',
          upstream: 'analytics',
        });
      }
    },
  );
}
