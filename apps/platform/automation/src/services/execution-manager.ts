import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import type { ExecutionRepository } from '../repositories/execution.repository.js';
import type { ActionJobData } from '../queue/index.js';
import { walkActionTree, type ActionNode } from './action-tree-walker.js';
import type { MatchedRule } from './rule-matcher.js';
import type { InboundEvent } from '../events/inbound-event.js';
import type { ExecutionManagerPort } from './event-consumer.js';

export class ExecutionManager implements ExecutionManagerPort {
  constructor(
    private readonly repo: ExecutionRepository,
    private readonly queue: Queue<ActionJobData>,
  ) {}

  async handle(rule: MatchedRule, event: InboundEvent): Promise<void> {
    // Step 1 — Idempotency
    const existing = await this.repo.findExecution(event.event_id, rule.rule.rule_id);
    if (existing !== null) {
      return;
    }

    // Step 2 — Insert execution
    const execution = await this.repo.insertExecution({
      id: randomUUID(),
      rule_id: rule.rule.rule_id,
      rule_version: rule.rule.rule_version,
      action_tree_snapshot: rule.rule.action_tree,
      event_id: event.event_id,
      event_type: event.event_type,
      entity_type: event.entity_type ?? null,
      entity_id: event.entity_id ?? null,
    });

    // Step 3 — Walk tree
    const steps = walkActionTree(rule.rule.action_tree as ActionNode, execution.id);

    // Step 4 — Bulk insert (no-op if steps is empty)
    await this.repo.insertSteps(steps);

    // Empty tree guard — complete immediately
    if (steps.length === 0) {
      await this.repo.updateExecutionStatus(execution.id, 'completed', new Date());
      return;
    }

    // Step 5 — Enqueue root job
    const rootStep = steps[0];
    await this.queue.add(rootStep.action_type, {
      execution_id: execution.id,
      step_id: rootStep.id,
      action_type: rootStep.action_type,
      action_params: rootStep.action_params,
      exec_ctx: rule.execCtx,
      event: event as Record<string, unknown>,
    });
  }
}
