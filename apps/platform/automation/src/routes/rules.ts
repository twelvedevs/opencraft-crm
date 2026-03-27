import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsync } from 'fastify';
import type { Knex } from 'knex';
import { RulesRepository } from '../repositories/rules.repository.js';

const RuleSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  status: Type.String(),
  active_version: Type.Union([Type.Number(), Type.Null()]),
  current_version: Type.Number(),
  created_by: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.Any(),
  updated_at: Type.Any(),
});

const rulesRoutes: FastifyPluginAsync<{ db: Knex }> = async (fastify, opts) => {
  const repo = new RulesRepository(opts.db);

  fastify.get(
    '/rules',
    {
      schema: {
        querystring: Type.Object({
          status: Type.Optional(
            Type.Union([
              Type.Literal('draft'),
              Type.Literal('active'),
              Type.Literal('disabled'),
            ]),
          ),
        }),
        response: {
          200: Type.Array(RuleSchema),
        },
      },
    },
    async (request, reply) => {
      const { status } = request.query as { status?: string };
      const rules = await repo.findAll(status ? { status } : undefined);
      return reply.send(rules);
    },
  );

  fastify.get(
    '/rules/:id',
    {
      schema: {
        params: Type.Object({
          id: Type.String(),
        }),
        response: {
          200: RuleSchema,
          404: Type.Object({ error: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const rule = await repo.findById(id);
      if (!rule) {
        return reply.status(404).send({ error: 'Not found' });
      }
      return reply.send(rule);
    },
  );
};

export default rulesRoutes;
