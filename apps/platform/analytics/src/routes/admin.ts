import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { env } from '../env.js';

// ---------------------------------------------------------------------------
// Valid rollup table names
// ---------------------------------------------------------------------------

const VALID_TABLES = [
  'metrics_leads_daily',
  'metrics_pipeline_daily',
  'metrics_conversions_daily',
  'metrics_messages_daily',
  'metrics_ad_spend_daily',
  'metrics_campaigns_daily',
  'metrics_referrals_daily',
  'metrics_coordinators_daily',
] as const;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const RecomputeBodySchema = Type.Object({
  table: Type.Union(VALID_TABLES.map((t) => Type.Literal(t))),
  date_range: Type.Object({
    from: Type.String({ minLength: 1 }),
    to: Type.String({ minLength: 1 }),
  }),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapBullMQState(state: string): 'pending' | 'active' | 'completed' | 'failed' {
  if (state === 'active') return 'active';
  if (state === 'completed') return 'completed';
  if (state === 'failed') return 'failed';
  // 'waiting', 'delayed', 'prioritized', etc.
  return 'pending';
}

function checkAdminKey(key: string | string[] | undefined): boolean {
  return key === env.ADMIN_RECOMPUTE_KEY;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function adminRoutes(
  app: FastifyInstance,
  options: { queue: Queue },
): Promise<void> {
  // POST /analytics/admin/recompute
  app.post('/analytics/admin/recompute', {
    schema: { body: RecomputeBodySchema },
  }, async (request, reply) => {
    if (!checkAdminKey(request.headers['x-admin-key'])) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const body = request.body as {
      table: string;
      date_range: { from: string; to: string };
    };

    const job = await options.queue.add('recompute', {
      table: body.table,
      date_range: body.date_range,
    });

    return reply.status(202).send({ job_id: job.id });
  });

  // GET /analytics/admin/recompute/:job_id
  app.get('/analytics/admin/recompute/:job_id', async (request, reply) => {
    if (!checkAdminKey(request.headers['x-admin-key'])) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { job_id } = request.params as { job_id: string };
    const job = await options.queue.getJob(job_id);

    if (!job) {
      return reply.status(404).send({ error: 'Job not found' });
    }

    const state = await job.getState();
    const status = mapBullMQState(state);

    const rows_written =
      status === 'completed' && job.returnvalue != null
        ? (job.returnvalue as { rows_written: number }).rows_written
        : null;

    const error = status === 'failed' ? (job.failedReason ?? null) : null;

    return reply.status(200).send({
      job_id: job.id,
      status,
      rows_written,
      error,
    });
  });
}
