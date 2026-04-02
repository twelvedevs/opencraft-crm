import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import * as accountsRepo from '../repositories/accounts.js';
import * as backfillJobsRepo from '../repositories/backfill-jobs.js';

export interface BackfillRoutesOpts {
  pool: Pool;
  backfillQueue: Queue;
}

const BackfillBodySchema = Type.Object({
  from: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  to: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
});

const MAX_BACKFILL_MONTHS = 24;

export async function backfillRoutes(
  fastify: FastifyInstance,
  opts: BackfillRoutesOpts,
): Promise<void> {
  const { pool, backfillQueue } = opts;

  // POST /integrations/accounts/:id/backfill
  fastify.post<{ Params: { id: string }; Body: unknown }>(
    '/integrations/accounts/:id/backfill',
    async (request, reply) => {
      if (!Value.Check(BackfillBodySchema, request.body)) {
        return reply.code(400).send({
          error: 'Invalid request body: expected { from: "YYYY-MM-DD", to: "YYYY-MM-DD" }',
        });
      }

      const body = request.body as { from: string; to: string };
      const { id } = request.params;

      const fromDate = new Date(body.from);
      const toDate = new Date(body.to);

      if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
        return reply.code(400).send({ error: 'Invalid date format' });
      }

      if (fromDate > toDate) {
        return reply.code(400).send({ error: '"from" must be before or equal to "to"' });
      }

      // Check max 24-month range
      const diffMs = toDate.getTime() - fromDate.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      const maxDays = MAX_BACKFILL_MONTHS * 31; // ~24 months
      if (diffDays > maxDays) {
        return reply.code(400).send({ error: `Date range exceeds maximum of ${MAX_BACKFILL_MONTHS} months` });
      }

      const client = await pool.connect();
      try {
        const account = await accountsRepo.findById(client, id);
        if (!account) {
          return reply.code(404).send({ error: 'Account not found' });
        }

        const totalDays = diffDays + 1;
        const chunksTotal = Math.ceil(totalDays / 7);

        const job = await backfillJobsRepo.insert(client, {
          account_id: id,
          from_date: body.from,
          to_date: body.to,
          chunks_total: chunksTotal,
        });

        await backfillQueue.add('backfill-ad-spend', {
          account_id: id,
          backfill_job_id: job.id,
        });

        return reply.code(201).send({ job_id: job.id });
      } finally {
        client.release();
      }
    },
  );

  // GET /integrations/accounts/:id/backfill/:job_id
  fastify.get<{ Params: { id: string; job_id: string } }>(
    '/integrations/accounts/:id/backfill/:job_id',
    async (request, reply) => {
      const { id, job_id } = request.params;

      const client = await pool.connect();
      try {
        const job = await backfillJobsRepo.findById(client, job_id);
        if (!job || job.account_id !== id) {
          return reply.code(404).send({ error: 'Backfill job not found' });
        }

        return {
          job_id: job.id,
          status: job.status,
          progress: {
            chunks_done: job.chunks_done,
            chunks_total: job.chunks_total,
          },
          ...(job.error ? { error: job.error } : {}),
        };
      } finally {
        client.release();
      }
    },
  );
}
