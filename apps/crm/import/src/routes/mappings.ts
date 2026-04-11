import { type FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { requireRole } from '@ortho/auth-middleware';
import type { ColumnMappingRepository } from '../repositories/column-mapping.repo.js';

const ALLOWED_IMPORT_TYPES = ['active_patients', 'completed_patients', 'scheduled_appointments', 'no_shows'] as const;

const rolePre = requireRole(['call_center_manager', 'marketing_manager']);

const GetMappingParamsSchema = Type.Object({
  type: Type.Union(ALLOWED_IMPORT_TYPES.map((t) => Type.Literal(t))),
});

export function mappingsRoutes(opts: {
  columnMappingRepo: ColumnMappingRepository;
}) {
  const { columnMappingRepo } = opts;

  return async function (app: FastifyInstance): Promise<void> {
    /**
     * GET /imports/column-mappings/:type — get saved column mapping for an import type
     */
    app.get(
      '/imports/column-mappings/:type',
      {
        schema: { tags: ['Mappings'], summary: 'Get column mapping template by type', params: GetMappingParamsSchema } as object,
        preHandler: [rolePre],
      },
      async (req, reply) => {
        const { type } = req.params as { type: string };

        const mapping = await columnMappingRepo.findByType(type);
        if (!mapping) {
          return reply.code(404).send({ error: 'no_mapping_found' });
        }

        return reply.code(200).send({
          import_type: mapping.import_type,
          mapping: mapping.mapping,
          updated_at: mapping.updated_at,
          updated_by: mapping.updated_by,
        });
      },
    );
  };
}
