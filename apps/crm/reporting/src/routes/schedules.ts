import { type FastifyInstance } from 'fastify';
import { requirePermission } from '@ortho/auth-middleware';
import { Type } from '@sinclair/typebox';
import { createLogger } from '@ortho/logger';
import db from '../db.js';
import * as schedulesRepo from '../repositories/schedules.js';
import * as configsRepo from '../repositories/report-configs.js';
import {
  registerSchedule,
  removeSchedule,
  replaceSchedule,
} from '../services/schedule-manager.js';
import { ScheduleBody } from '../schemas/schedule.js';

const log = createLogger('crm-reporting');
const readPerm = requirePermission('reporting:read');
const writePerm = requirePermission('reporting:write');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ScheduleParams = Type.Object({ id: Type.String() });

function validateEmails(emails: string[]): string[] {
  return emails.filter((e) => !EMAIL_REGEX.test(e));
}

export async function scheduleRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /reporting/schedules
   *
   * Returns schedules belonging to the caller's own report configs.
   */
  app.get(
    '/reporting/schedules',
    { schema: { tags: ['Schedules'], summary: 'List report schedules' } as object, preHandler: [readPerm] },
    async (req, reply) => {
      const userConfigs = await configsRepo.findByCreatedBy(db, req.user!.sub);
      const nested = await Promise.all(
        userConfigs.map((c) => schedulesRepo.findByReportConfigId(db, c.id)),
      );
      return reply.code(200).send({ data: nested.flat() });
    },
  );

  /**
   * POST /reporting/schedules
   *
   * Creates a schedule and registers a BullMQ repeatable job.
   */
  app.post(
    '/reporting/schedules',
    { schema: { body: ScheduleBody, tags: ['Schedules'], summary: 'Create report schedule' }, preHandler: [writePerm] },
    async (req, reply) => {
      const body = req.body as typeof ScheduleBody._type;

      const invalid = validateEmails(body.recipient_emails);
      if (invalid.length > 0) {
        return reply.code(400).send({
          error: 'invalid_email',
          message: `Invalid email addresses: ${invalid.join(', ')}`,
        });
      }

      const config = await configsRepo.findById(db, body.report_config_id);
      if (!config) {
        return reply.code(404).send({
          error: 'not_found',
          message: 'Report config not found',
        });
      }

      const isManager =
        req.user!.role === 'marketing_manager' || req.user!.role === 'super_admin';
      if (config.created_by !== req.user!.sub && !isManager) {
        return reply.code(403).send({
          error: 'forbidden',
          message: 'Not authorized to schedule this report config',
        });
      }

      const schedule = await schedulesRepo.create(db, body, req.user!.sub);

      try {
        await registerSchedule(schedule);
      } catch (err) {
        log.error({ err, scheduleId: schedule.id }, 'Failed to register BullMQ schedule');
        return reply.code(500).send({
          error: 'schedule_error',
          message: 'Schedule saved but BullMQ registration failed',
        });
      }

      return reply.code(201).send(schedule);
    },
  );

  /**
   * PUT /reporting/schedules/:id
   *
   * Updates the DB row then replaces the BullMQ repeatable job.
   * On BullMQ failure after a successful DB update: logs and returns 500.
   */
  app.put(
    '/reporting/schedules/:id',
    {
      schema: { params: ScheduleParams, body: ScheduleBody, tags: ['Schedules'], summary: 'Update report schedule' },
      preHandler: [writePerm],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as typeof ScheduleBody._type;

      if (body.recipient_emails) {
        const invalid = validateEmails(body.recipient_emails);
        if (invalid.length > 0) {
          return reply.code(400).send({
            error: 'invalid_email',
            message: `Invalid email addresses: ${invalid.join(', ')}`,
          });
        }
      }

      const existing = await schedulesRepo.findById(db, id);
      if (!existing) {
        return reply.code(404).send({ error: 'not_found', message: 'Schedule not found' });
      }

      const updated = await schedulesRepo.update(db, id, body);
      if (!updated) {
        return reply.code(404).send({ error: 'not_found', message: 'Schedule not found' });
      }

      try {
        await replaceSchedule(id, updated);
      } catch (err) {
        log.error({ err, scheduleId: id }, 'BullMQ replaceSchedule failed after DB update');
        return reply.code(500).send({
          error: 'schedule_error',
          message: 'DB updated but BullMQ replace failed',
        });
      }

      return reply.code(200).send(updated);
    },
  );

  /**
   * DELETE /reporting/schedules/:id
   *
   * Sets active=false in DB and removes the BullMQ repeatable job.
   */
  app.delete(
    '/reporting/schedules/:id',
    { schema: { params: ScheduleParams, tags: ['Schedules'], summary: 'Delete report schedule' }, preHandler: [writePerm] },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      const existing = await schedulesRepo.findById(db, id);
      if (!existing) {
        return reply.code(404).send({ error: 'not_found', message: 'Schedule not found' });
      }

      await schedulesRepo.setActive(db, id, false);

      try {
        await removeSchedule(id);
      } catch (err) {
        log.error({ err, scheduleId: id }, 'BullMQ removeSchedule failed (DB already deactivated)');
      }

      return reply.code(204).send();
    },
  );
}
