import { type FastifyInstance } from 'fastify';
import { requirePermission } from '@ortho/auth-middleware';
import { Type } from '@sinclair/typebox';
import db from '../db.js';
import * as runsRepo from '../repositories/runs.js';
import * as configsRepo from '../repositories/report-configs.js';
import { reportingQueue } from '../services/schedule-manager.js';
import { env } from '../env.js';
import { GENERATE_REPORT_JOB_OPTIONS } from '../jobs/generate-report.js';

const readPerm = requirePermission('reporting:read');

const MANAGER_ROLES = new Set(['marketing_manager', 'super_admin']);

const RunParams = Type.Object({ id: Type.String() });
const RunListQuery = Type.Object({
  config_id: Type.Optional(Type.String()),
});

function canAccessRun(
  triggeredBy: string,
  configLocationIds: unknown,
  userId: string,
  userRole: string,
  userLocations: string[],
): boolean {
  if (MANAGER_ROLES.has(userRole)) return true;
  if (triggeredBy === userId) return true;
  const locationIds = Array.isArray(configLocationIds) ? (configLocationIds as string[]) : [];
  if (locationIds.length > 0) {
    const locationSet = new Set(userLocations);
    return locationIds.every((lid) => locationSet.has(lid));
  }
  return false;
}

async function getPresignedUrl(fileId: string): Promise<string> {
  const res = await fetch(
    `${env.MEDIA_SERVICE_URL}/media/internal/${fileId}/signed-url`,
    { headers: { Authorization: `Bearer ${env.INTERNAL_API_SECRET}` } },
  );
  if (!res.ok) {
    throw new Error(`Media Service returned ${res.status} for signed-url`);
  }
  const data = (await res.json()) as { url: string };
  return data.url;
}

export async function runRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /reporting/runs?config_id=
   *
   * Returns run history for the given report config, ordered by started_at DESC.
   * Caller must own the config or be marketing_manager+.
   */
  app.get(
    '/reporting/runs',
    { schema: { querystring: RunListQuery, tags: ['Runs'], summary: 'List report runs' }, preHandler: [readPerm] },
    async (req, reply) => {
      const q = req.query as { config_id?: string };
      if (!q.config_id) {
        return reply.code(400).send({
          error: 'missing_param',
          message: 'config_id query param is required',
        });
      }

      const config = await configsRepo.findById(db, q.config_id);
      if (!config) {
        return reply.code(404).send({ error: 'not_found', message: 'Report config not found' });
      }
      const canRead =
        MANAGER_ROLES.has(req.user!.role) || config.created_by === req.user!.sub;
      if (!canRead) {
        return reply.code(403).send({ error: 'forbidden', message: 'Not authorized to view runs for this config' });
      }

      const runs = await runsRepo.findByConfigId(db, q.config_id);
      return reply.code(200).send({ data: runs });
    },
  );

  /**
   * GET /reporting/runs/:id
   *
   * Returns a single run by ID. Caller must have access using the same
   * ownership/location rules as download and retry.
   */
  app.get(
    '/reporting/runs/:id',
    { schema: { params: RunParams, tags: ['Runs'], summary: 'Get report run by ID' }, preHandler: [readPerm] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const run = await runsRepo.findById(db, id);
      if (!run) {
        return reply.code(404).send({ error: 'not_found', message: 'Run not found' });
      }

      const config = await configsRepo.findById(db, run.report_config_id);
      const allowed = canAccessRun(
        run.triggered_by,
        config?.parameters?.location_ids,
        req.user!.sub,
        req.user!.role,
        req.user!.locations,
      );
      if (!allowed) {
        return reply.code(403).send({ error: 'forbidden', message: 'Not authorized to view this run' });
      }

      return reply.code(200).send(run);
    },
  );

  /**
   * GET /reporting/runs/:id/download
   *
   * Verifies access then redirects (302) to a fresh Media Service presigned URL.
   */
  app.get(
    '/reporting/runs/:id/download',
    { schema: { params: RunParams, tags: ['Runs'], summary: 'Download report run as PDF/CSV' }, preHandler: [readPerm] },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      const run = await runsRepo.findById(db, id);
      if (!run) {
        return reply.code(404).send({ error: 'not_found', message: 'Run not found' });
      }
      if (!run.media_file_id) {
        return reply.code(409).send({
          error: 'not_ready',
          message: 'Report file is not yet available',
        });
      }

      const config = await configsRepo.findById(db, run.report_config_id);
      const allowed = canAccessRun(
        run.triggered_by,
        config?.parameters?.location_ids,
        req.user!.sub,
        req.user!.role,
        req.user!.locations,
      );
      if (!allowed) {
        return reply.code(403).send({ error: 'forbidden', message: 'Not authorized to download this run' });
      }

      const presignedUrl = await getPresignedUrl(run.media_file_id);
      return reply.redirect(presignedUrl, 302);
    },
  );

  /**
   * POST /reporting/runs/:id/retry
   *
   * Requires run.status='failed'. Creates a new run row (original unchanged)
   * and enqueues a fresh generate-report job. Returns 202 { run_id }.
   */
  app.post(
    '/reporting/runs/:id/retry',
    { schema: { params: RunParams, tags: ['Runs'], summary: 'Retry failed report run' }, preHandler: [readPerm] },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      const run = await runsRepo.findById(db, id);
      if (!run) {
        return reply.code(404).send({ error: 'not_found', message: 'Run not found' });
      }
      if (run.status !== 'failed') {
        return reply.code(400).send({
          error: 'invalid_state',
          message: 'Only failed runs can be retried',
        });
      }

      const config = await configsRepo.findById(db, run.report_config_id);
      const allowed = canAccessRun(
        run.triggered_by,
        config?.parameters?.location_ids,
        req.user!.sub,
        req.user!.role,
        req.user!.locations,
      );
      if (!allowed) {
        return reply.code(403).send({ error: 'forbidden', message: 'Not authorized to retry this run' });
      }

      const newRun = await runsRepo.create(db, {
        report_config_id: run.report_config_id,
        report_schedule_id: run.report_schedule_id ?? undefined,
        triggered_by: req.user!.sub,
        format: run.format,
        status: 'pending',
        recipient_emails: run.recipient_emails ?? undefined,
      });

      await reportingQueue.add(
        'generate-report',
        {
          report_config_id: run.report_config_id,
          report_run_id: newRun.id,
          format: run.format,
          recipient_emails: run.recipient_emails ?? undefined,
        },
        GENERATE_REPORT_JOB_OPTIONS,
      );

      return reply.code(202).send({ run_id: newRun.id });
    },
  );
}
