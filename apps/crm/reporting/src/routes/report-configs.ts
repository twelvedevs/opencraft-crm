import { type FastifyInstance } from 'fastify';
import { requirePermission } from '@ortho/auth-middleware';
import { Type } from '@sinclair/typebox';
import db from '../db.js';
import * as configsRepo from '../repositories/report-configs.js';
import * as runsRepo from '../repositories/runs.js';
import { reportingQueue } from '../services/schedule-manager.js';
import {
  ReportConfigBody,
  ReportConfigParams,
} from '../schemas/report-config.js';
import { GENERATE_REPORT_JOB_OPTIONS } from '../jobs/generate-report.js';

const readPerm = requirePermission('reporting:read');

const MANAGER_ROLES = new Set(['marketing_manager', 'super_admin']);

function isManagerRole(role: string): boolean {
  return MANAGER_ROLES.has(role);
}

/**
 * Validate that a scoped role (call_center_agent/manager) only requests
 * location_ids that appear in their JWT locations. Returns a 403 error
 * payload if invalid, or null if OK.
 */
function checkLocationScope(
  role: string,
  jwtLocations: string[],
  paramLocationIds: string[] | undefined,
): { error: string; message: string } | null {
  if (role !== 'call_center_agent' && role !== 'call_center_manager') {
    return null;
  }
  if (!paramLocationIds || paramLocationIds.length === 0) {
    return null;
  }
  const allowed = new Set(jwtLocations);
  const forbidden = paramLocationIds.filter(id => !allowed.has(id));
  if (forbidden.length > 0) {
    return {
      error: 'forbidden',
      message: `Location IDs not accessible: ${forbidden.join(', ')}`,
    };
  }
  return null;
}

const GetQuerySchema = Type.Object({
  type: Type.Optional(Type.String()),
  all: Type.Optional(Type.String()),
});

const GenerateQuerySchema = Type.Object({
  format: Type.Optional(
    Type.Union([Type.Literal('pdf'), Type.Literal('csv')]),
  ),
});

export async function reportConfigRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /reporting/report-configs
   *
   * Without all=true: returns only the caller's own configs.
   * With all=true and marketing_manager+ role: returns all configs.
   * Optional ?type= filter applied.
   */
  app.get(
    '/reporting/report-configs',
    {
      schema: { querystring: GetQuerySchema, tags: ['Report Configs'], summary: 'List report configurations' },
      preHandler: [readPerm],
    },
    async (req, reply) => {
      const q = req.query as { type?: string; all?: string };
      const typeFilter = q.type;
      const showAll = q.all === 'true' && isManagerRole(req.user!.role);

      const configs = showAll
        ? await configsRepo.findAll(db, typeFilter)
        : await configsRepo.findByCreatedBy(db, req.user!.sub, typeFilter);

      return reply.code(200).send({ data: configs });
    },
  );

  /**
   * POST /reporting/report-configs
   *
   * All roles may create. Scoped roles validated against their JWT locations.
   */
  app.post(
    '/reporting/report-configs',
    {
      schema: { body: ReportConfigBody, tags: ['Report Configs'], summary: 'Create report configuration' },
      preHandler: [readPerm],
    },
    async (req, reply) => {
      const body = req.body as typeof ReportConfigBody._type;

      const scopeError = checkLocationScope(
        req.user!.role,
        req.user!.locations,
        body.parameters?.location_ids,
      );
      if (scopeError) {
        return reply.code(403).send(scopeError);
      }

      const config = await configsRepo.create(db, body, req.user!.sub);
      return reply.code(201).send(config);
    },
  );

  /**
   * PUT /reporting/report-configs/:id
   *
   * Caller must own the config OR have marketing_manager+ role.
   * Location scoping enforced on parameters.location_ids.
   */
  app.put(
    '/reporting/report-configs/:id',
    {
      schema: { params: ReportConfigParams, body: ReportConfigBody, tags: ['Report Configs'], summary: 'Update report configuration' },
      preHandler: [readPerm],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as typeof ReportConfigBody._type;

      const existing = await configsRepo.findById(db, id);
      if (!existing) {
        return reply.code(404).send({ error: 'not_found', message: 'Report config not found' });
      }

      if (existing.created_by !== req.user!.sub && !isManagerRole(req.user!.role)) {
        return reply.code(403).send({ error: 'forbidden', message: 'Not authorized to update this config' });
      }

      const scopeError = checkLocationScope(
        req.user!.role,
        req.user!.locations,
        body.parameters?.location_ids,
      );
      if (scopeError) {
        return reply.code(403).send(scopeError);
      }

      const updated = await configsRepo.update(db, id, body);
      return reply.code(200).send(updated);
    },
  );

  /**
   * DELETE /reporting/report-configs/:id
   *
   * Caller must own the config OR have marketing_manager+ role.
   */
  app.delete(
    '/reporting/report-configs/:id',
    {
      schema: { params: ReportConfigParams },
      preHandler: [readPerm],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      const existing = await configsRepo.findById(db, id);
      if (!existing) {
        return reply.code(404).send({ error: 'not_found', message: 'Report config not found' });
      }

      if (existing.created_by !== req.user!.sub && !isManagerRole(req.user!.role)) {
        return reply.code(403).send({ error: 'forbidden', message: 'Not authorized to delete this config' });
      }

      await configsRepo.deleteById(db, id);
      return reply.code(204).send();
    },
  );

  /**
   * POST /reporting/report-configs/:id/generate?format=pdf|csv
   *
   * Creates a report_run row (status=pending) and enqueues a BullMQ job.
   * Returns 202 { run_id }.
   */
  app.post(
    '/reporting/report-configs/:id/generate',
    {
      schema: {
        params: ReportConfigParams,
        querystring: GenerateQuerySchema,
        tags: ['Report Configs'],
        summary: 'Generate report from configuration',
      },
      preHandler: [readPerm],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const q = req.query as { format?: 'pdf' | 'csv' };
      const format = q.format ?? 'pdf';

      const config = await configsRepo.findById(db, id);
      if (!config) {
        return reply.code(404).send({ error: 'not_found', message: 'Report config not found' });
      }

      if (config.created_by !== req.user!.sub && !isManagerRole(req.user!.role)) {
        return reply.code(403).send({ error: 'forbidden', message: 'Not authorized to generate this report' });
      }

      const run = await runsRepo.create(db, {
        report_config_id: id,
        triggered_by: req.user!.sub,
        format,
        status: 'pending',
        recipient_emails: undefined,
      });

      await reportingQueue.add(
        'generate-report',
        {
          report_config_id: id,
          report_run_id: run.id,
          format,
        },
        GENERATE_REPORT_JOB_OPTIONS,
      );

      return reply.code(202).send({ run_id: run.id });
    },
  );
}
