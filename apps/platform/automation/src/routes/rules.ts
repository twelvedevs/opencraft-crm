import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsync } from 'fastify';
import type { Knex } from 'knex';
import { RulesRepository, type UpdateRuleWithVersionInput } from '../repositories/rules.repository.js';
import { validateActionTree } from '../services/rule-validator.js';
import type { JobCanceller } from '../services/job-canceller.js';
import { evaluate, type Condition } from '../services/condition-evaluator.js';
import { resolveDryRunPath } from '../services/dry-run-walker.js';
import type { ActionNode } from '../services/action-tree-walker.js';

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

const rulesRoutes: FastifyPluginAsync<{ db: Knex; jobCanceller?: JobCanceller }> = async (fastify, opts) => {
  const repo = new RulesRepository(opts.db);

  fastify.get(
    '/rules',
    {
      schema: {
        tags: ['Rules'],
        summary: 'List automation rules',
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
        tags: ['Rules'],
        summary: 'Get rule by ID',
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
  const PostRuleBodySchema = Type.Object({
    name: Type.String(),
    trigger_event_type: Type.String(),
    condition: Type.Optional(Type.Any()),
    active_hours: Type.Optional(Type.Any()),
    action_tree: Type.Any(),
    created_by: Type.Optional(Type.String()),
  });

  fastify.post(
    '/rules',
    {
      schema: {
        tags: ['Rules'],
        summary: 'Create automation rule',
        body: PostRuleBodySchema,
        response: {
          201: RuleSchema,
          422: Type.Object({ errors: Type.Array(Type.String()) }),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        name: string;
        trigger_event_type: string;
        condition?: unknown;
        active_hours?: unknown;
        action_tree: unknown;
        created_by?: string;
      };

      const validation = validateActionTree(body.action_tree);
      if (!validation.valid) {
        return reply.status(422).send({ errors: validation.errors });
      }

      const rule = await repo.createWithVersion({
        name: body.name,
        trigger_event_type: body.trigger_event_type,
        condition: body.condition,
        active_hours: body.active_hours,
        action_tree: body.action_tree,
        created_by: body.created_by,
      });

      return reply.status(201).send(rule);
    },
  );

  const PutRuleBodySchema = Type.Object({
    name: Type.Optional(Type.String()),
    trigger_event_type: Type.Optional(Type.String()),
    condition: Type.Optional(Type.Any()),
    active_hours: Type.Optional(Type.Any()),
    action_tree: Type.Optional(Type.Any()),
  });

  fastify.put(
    '/rules/:id',
    {
      schema: {
        tags: ['Rules'],
        summary: 'Update automation rule',
        params: Type.Object({ id: Type.String() }),
        body: PutRuleBodySchema,
        response: {
          200: RuleSchema,
          404: Type.Object({ error: Type.String() }),
          422: Type.Object({ errors: Type.Array(Type.String()) }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as UpdateRuleWithVersionInput;

      if (body.action_tree !== undefined) {
        const validation = validateActionTree(body.action_tree);
        if (!validation.valid) {
          return reply.status(422).send({ errors: validation.errors });
        }
      }

      const rule = await repo.updateWithVersion(id, body);
      if (!rule) {
        return reply.status(404).send({ error: 'Not found' });
      }
      return reply.send(rule);
    },
  );

  fastify.put(
    '/rules/:id/versions/:v/activate',
    {
      schema: {
        tags: ['Rules'],
        summary: 'Activate rule version',
        params: Type.Object({ id: Type.String(), v: Type.String() }),
        response: {
          200: RuleSchema,
          404: Type.Object({ error: Type.String() }),
          409: Type.Object({ error: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { id, v } = request.params as { id: string; v: string };
      const version = parseInt(v, 10);

      const rule = await repo.findByIdRaw(id);
      if (!rule) {
        return reply.status(404).send({ error: 'Not found' });
      }
      if (rule.status === 'deleted') {
        return reply.status(409).send({ error: 'Rule is deleted' });
      }

      const ruleVersion = await repo.findVersion(id, version);
      if (!ruleVersion) {
        return reply.status(404).send({ error: 'Not found' });
      }

      const updated = await repo.activateVersion(id, version);
      return reply.send(updated);
    },
  );

  const PatchStatusBodySchema = Type.Object({
    status: Type.Union([Type.Literal('active'), Type.Literal('disabled')]),
  });

  fastify.patch(
    '/rules/:id/status',
    {
      schema: {
        tags: ['Rules'],
        summary: 'Update rule status',
        params: Type.Object({ id: Type.String() }),
        body: PatchStatusBodySchema,
        response: {
          200: RuleSchema,
          404: Type.Object({ error: Type.String() }),
          422: Type.Object({ error: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { status } = request.body as { status: string };

      if (status !== 'active' && status !== 'disabled') {
        return reply.status(422).send({ error: 'status must be active or disabled' });
      }

      const rule = await repo.updateStatus(id, status);
      if (!rule) {
        return reply.status(404).send({ error: 'Not found' });
      }
      if (status === 'disabled') {
        await opts.jobCanceller?.cancelDelayedJobsForRule(id);
      }
      return reply.send(rule);
    },
  );

  fastify.delete(
    '/rules/:id',
    {
      schema: {
        tags: ['Rules'],
        summary: 'Delete automation rule',
        params: Type.Object({
          id: Type.String(),
        }),
        response: {
          204: Type.Null(),
          404: Type.Object({ error: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const deleted = await repo.softDelete(id);
      if (!deleted) {
        return reply.status(404).send({ error: 'Not found' });
      }
      await opts.jobCanceller?.cancelDelayedJobsForRule(id);
      return reply.status(204).send();
    },
  );

  const TestRuleBodySchema = Type.Object({
    event_type: Type.String(),
    payload: Type.Record(Type.String(), Type.Unknown()),
    entity_type: Type.Optional(Type.String()),
    entity_id: Type.Optional(Type.String()),
  });

  fastify.post(
    '/rules/:id/test',
    {
      schema: {
        tags: ['Rules'],
        summary: 'Test rule with event',
        params: Type.Object({ id: Type.String() }),
        body: TestRuleBodySchema,
        response: {
          200: Type.Object({
            matches: Type.Boolean(),
            would_execute: Type.Array(
              Type.Object({
                action_type: Type.String(),
                action_params: Type.Record(Type.String(), Type.Unknown()),
              }),
            ),
          }),
          404: Type.Object({ error: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        event_type: string;
        payload: Record<string, unknown>;
        entity_type?: string;
        entity_id?: string;
      };

      const rule = await repo.findById(id);
      if (!rule) {
        return reply.status(404).send({ error: 'rule not found' });
      }

      const version = await repo.findVersion(id, rule.current_version);
      if (!version) {
        return reply.status(404).send({ error: 'rule version not found' });
      }

      const conditionMatches = evaluate(
        version.condition as Condition | null | undefined,
        body.payload,
        { event_id: 'dry-run', execution_id: 'dry-run', rule_id: id, rule_version: rule.current_version },
      );

      if (!conditionMatches) {
        return reply.send({ matches: false, would_execute: [] });
      }

      const would_execute = resolveDryRunPath(version.action_tree as ActionNode, body.payload);

      return reply.send({ matches: true, would_execute });
    },
  );
};

export default rulesRoutes;
