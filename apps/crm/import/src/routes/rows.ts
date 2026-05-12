import { type FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { requireRole } from '@ortho/auth-middleware';
import type { ImportService } from '../services/import.service.js';
import { ImportServiceError } from '../services/import.service.js';
import type { ImportRowRepository } from '../repositories/import-row.repo.js';

const rolePre = requireRole(['call_center_manager', 'marketing_manager']);

const LOCATION_BYPASS_ROLES = ['marketing_staff', 'marketing_manager', 'super_admin'];

const ROW_STATUSES = ['matched', 'unmatched', 'ambiguous', 'failed', 'pending'] as const;

const GetRowsParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

const GetRowsQuerySchema = Type.Object({
  status: Type.Optional(Type.Union(ROW_STATUSES.map((s) => Type.Literal(s)))),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
  cursor: Type.Optional(Type.Integer({ minimum: 0 })),
});

export function rowsRoutes(opts: {
  importService: ImportService;
  importRowRepo: ImportRowRepository;
}) {
  const { importService, importRowRepo } = opts;

  return async function (app: FastifyInstance): Promise<void> {
    /**
     * GET /imports/:id/rows — list import rows with cursor pagination
     */
    app.get(
      '/imports/:id/rows',
      {
        schema: { tags: ['Rows'], summary: 'List import rows with match status', params: GetRowsParamsSchema, querystring: GetRowsQuerySchema } as object,
        preHandler: [rolePre],
      },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const q = req.query as {
          status?: string;
          limit?: number;
          cursor?: number;
        };

        // Validate import exists
        let importRecord;
        try {
          importRecord = await importService.getImport(id);
        } catch (err) {
          if (err instanceof ImportServiceError) {
            return reply.code(err.statusCode).send(err.body);
          }
          throw err;
        }

        // Validate user has access to this import's location
        const user = req.user!;
        if (
          !LOCATION_BYPASS_ROLES.includes(user.role) &&
          !user.locations?.includes(importRecord.location_id)
        ) {
          return reply.code(403).send({ error: 'forbidden' });
        }

        const limit = q.limit ?? 50;
        const result = await importRowRepo.findByImportId(
          id,
          q.status,
          q.cursor,
          limit,
        );

        return reply.code(200).send(result);
      },
    );
  };
}
