import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsync } from 'fastify';
import type { SequenceDefinitionsRepository } from '../repositories/sequence-definitions.repo.js';
import type { SequenceVersionsRepository } from '../repositories/sequence-versions.repo.js';
import type { VersioningService } from '../services/versioning.service.js';

export interface SequencesRouteOptions {
  definitionsRepo: SequenceDefinitionsRepository;
  versionsRepo: SequenceVersionsRepository;
  versioningService: VersioningService;
}

const CreateBodySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
});

const ListQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  cursor: Type.Optional(Type.String()),
});

const ParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

const SaveDraftBodySchema = Type.Object({
  active_hours: Type.Optional(Type.Unknown()),
  cancel_on_opt_out: Type.Optional(Type.Boolean()),
  steps: Type.Array(Type.Unknown()),
  ab_test: Type.Optional(Type.Unknown()),
});

const sequencesRoutes: FastifyPluginAsync<SequencesRouteOptions> = async (fastify, opts) => {
  const { definitionsRepo, versionsRepo, versioningService } = opts;

  fastify.post(
    '/sequences',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: CreateBodySchema,
      },
    },
    async (request, reply) => {
      const { name } = request.body as { name: string };
      const created_by = (request.user as { sub: string; role: string }).sub;

      const def = await definitionsRepo.create({ name, created_by });
      await versionsRepo.insert({
        sequence_id: def.id,
        version: 1,
        steps: [],
        cancel_on_opt_out: true,
        created_by,
      });

      return reply.code(201).send({
        id: def.id,
        name: def.name,
        status: def.status,
        current_version: def.current_version,
        active_version: def.active_version,
        created_at: def.created_at,
      });
    },
  );

  fastify.get(
    '/sequences',
    {
      preHandler: [fastify.authenticate],
      schema: {
        querystring: ListQuerySchema,
      },
    },
    async (request, reply) => {
      const query = request.query as { limit?: number; cursor?: string };
      const limit = query.limit ?? 20;
      const cursor = query.cursor;

      const definitions = await definitionsRepo.findAll({ limit, cursor });

      const result = await Promise.all(
        definitions.map(async (def) => {
          let step_count = 0;
          const version = await versionsRepo.findBySequenceAndVersion(def.id, def.current_version);
          if (version && Array.isArray(version.steps)) {
            step_count = (version.steps as unknown[]).length;
          }
          return {
            id: def.id,
            name: def.name,
            status: def.status,
            active_version: def.active_version,
            current_version: def.current_version,
            step_count,
            created_at: def.created_at,
          };
        }),
      );

      return reply.send(result);
    },
  );

  fastify.get(
    '/sequences/:id',
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: ParamsSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const def = await definitionsRepo.findById(id);
      if (!def) {
        return reply.code(404).send({ error: 'sequence_not_found' });
      }

      const activeVersion =
        def.active_version != null
          ? await versionsRepo.findBySequenceAndVersion(id, def.active_version)
          : null;

      const currentVersion = await versionsRepo.findBySequenceAndVersion(id, def.current_version);

      return reply.send({
        ...def,
        active_version_data: activeVersion,
        current_version_data: currentVersion,
      });
    },
  );
  fastify.put(
    '/sequences/:id',
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: ParamsSchema,
        body: SaveDraftBodySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        active_hours?: unknown;
        cancel_on_opt_out?: boolean;
        steps: unknown[];
        ab_test?: unknown;
      };
      const createdBy = (request.user as { sub: string; role: string }).sub;

      try {
        const result = await versioningService.saveDraft(id, body, createdBy);
        return reply.send(result);
      } catch (err) {
        if (err instanceof Error && err.message === 'sequence_not_found') {
          return reply.code(404).send({ error: 'sequence_not_found' });
        }
        throw err;
      }
    },
  );
};

export default sequencesRoutes;
