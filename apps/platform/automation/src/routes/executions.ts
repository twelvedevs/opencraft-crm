import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsync } from 'fastify';
import type { Knex } from 'knex';
import { ExecutionRepository } from '../repositories/execution.repository.js';

const StepSchema = Type.Object({
  id: Type.String(),
  execution_id: Type.String(),
  action_type: Type.String(),
  action_params: Type.Any(),
  output: Type.Any(),
  status: Type.String(),
  attempt: Type.Number(),
  error: Type.Union([Type.String(), Type.Null()]),
  started_at: Type.Any(),
  completed_at: Type.Any(),
});

const ExecutionWithStepsSchema = Type.Object({
  id: Type.String(),
  rule_id: Type.String(),
  rule_version: Type.Number(),
  action_tree_snapshot: Type.Any(),
  event_id: Type.String(),
  event_type: Type.String(),
  entity_type: Type.Union([Type.String(), Type.Null()]),
  entity_id: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
  started_at: Type.Any(),
  completed_at: Type.Any(),
  steps: Type.Array(StepSchema),
});

const executionRoutes: FastifyPluginAsync<{ db: Knex }> = async (fastify, opts) => {
  const repo = new ExecutionRepository(opts.db);

  fastify.get(
    '/executions',
    {
      schema: {
        tags: ['Executions'],
        summary: 'List executions',
        querystring: Type.Object({
          rule_id: Type.Optional(Type.String()),
          entity_id: Type.Optional(Type.String()),
          status: Type.Optional(
            Type.Union([
              Type.Literal('pending'),
              Type.Literal('running'),
              Type.Literal('completed'),
              Type.Literal('failed'),
            ]),
          ),
          from: Type.Optional(Type.String()),
          to: Type.Optional(Type.String()),
          page: Type.Optional(Type.Integer({ default: 1 })),
          limit: Type.Optional(Type.Integer({ default: 20, maximum: 100 })),
        }),
        response: {
          200: Type.Array(ExecutionWithStepsSchema),
        },
      },
    },
    async (request, reply) => {
      const q = request.query as {
        rule_id?: string;
        entity_id?: string;
        status?: string;
        from?: string;
        to?: string;
        page?: number;
        limit?: number;
      };

      const filters: { rule_id?: string; entity_id?: string; status?: string; from?: Date; to?: Date } = {};
      if (q.rule_id !== undefined) filters.rule_id = q.rule_id;
      if (q.entity_id !== undefined) filters.entity_id = q.entity_id;
      if (q.status !== undefined) filters.status = q.status;
      if (q.from !== undefined) filters.from = new Date(q.from);
      if (q.to !== undefined) filters.to = new Date(q.to);

      const pagination = { page: q.page ?? 1, limit: q.limit ?? 20 };

      const executions = await repo.listExecutions(filters, pagination);
      return reply.send(executions);
    },
  );

  fastify.get(
    '/executions/:executionId/steps/:stepId/output',
    {
      schema: {
        tags: ['Executions'],
        summary: 'Get step output',
        params: Type.Object({
          executionId: Type.String(),
          stepId: Type.String(),
        }),
        response: {
          200: Type.Object({ output: Type.Any() }),
          404: Type.Object({ error: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { executionId, stepId } = request.params as { executionId: string; stepId: string };
      const result = await repo.findStepOutput(executionId, stepId);
      if (result === null) {
        return reply.status(404).send({ error: 'not found' });
      }
      return reply.send(result);
    },
  );
};

export default executionRoutes;
