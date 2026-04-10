import { type FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { requireRole } from '@ortho/auth-middleware';
import type { Queue } from 'bullmq';
import type { ImportService } from '../services/import.service.js';
import { ImportServiceError } from '../services/import.service.js';
import type { ImportJobData } from '../workers/import-job.js';

const rolePre = requireRole(['call_center_manager', 'marketing_manager']);

const ActionParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

const ConfirmBodySchema = Type.Object({
  column_mapping: Type.Record(Type.String(), Type.String()),
});

export function actionsRoutes(opts: {
  importService: ImportService;
  importQueue: Queue<ImportJobData>;
}) {
  const { importService, importQueue } = opts;

  return async function (app: FastifyInstance): Promise<void> {
    /**
     * POST /imports/:id/confirm — confirm import and start execute phase
     */
    app.post(
      '/imports/:id/confirm',
      {
        schema: { params: ActionParamsSchema, body: ConfirmBodySchema },
        preHandler: [rolePre],
      },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const { column_mapping } = req.body as { column_mapping: Record<string, string> };

        try {
          const record = await importService.confirmImport(id, column_mapping, req.user!.sub);
          await importQueue.add('import-job', { import_id: id, phase: 'execute' });
          return reply.code(202).send(record);
        } catch (err) {
          if (err instanceof ImportServiceError) {
            return reply.code(err.statusCode).send(err.body);
          }
          throw err;
        }
      },
    );

    /**
     * POST /imports/:id/cancel — cancel a preview_ready import
     */
    app.post(
      '/imports/:id/cancel',
      {
        schema: { params: ActionParamsSchema },
        preHandler: [rolePre],
      },
      async (req, reply) => {
        const { id } = req.params as { id: string };

        try {
          const record = await importService.cancelImport(id);
          return reply.code(200).send(record);
        } catch (err) {
          if (err instanceof ImportServiceError) {
            return reply.code(err.statusCode).send(err.body);
          }
          throw err;
        }
      },
    );

    /**
     * POST /imports/:id/undo — undo a completed import within the 2-hour window
     */
    app.post(
      '/imports/:id/undo',
      {
        schema: { params: ActionParamsSchema },
        preHandler: [rolePre],
      },
      async (req, reply) => {
        const { id } = req.params as { id: string };

        try {
          const record = await importService.initiateUndo(id);
          await importQueue.add('import-job', { import_id: id, phase: 'undo' });
          return reply.code(202).send(record);
        } catch (err) {
          if (err instanceof ImportServiceError) {
            return reply.code(err.statusCode).send(err.body);
          }
          throw err;
        }
      },
    );
  };
}
