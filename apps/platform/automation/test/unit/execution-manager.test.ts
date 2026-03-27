import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Queue } from 'bullmq';
import type { ExecutionRepository } from '../../src/repositories/execution.repository.js';
import type { ActionJobData } from '../../src/queue/index.js';
import type { MatchedRule } from '../../src/services/rule-matcher.js';
import type { InboundEvent } from '../../src/events/inbound-event.js';

vi.mock('../../src/services/action-tree-walker.js', () => ({
  walkActionTree: vi.fn(),
}));

import { ExecutionManager } from '../../src/services/execution-manager.js';
import { walkActionTree } from '../../src/services/action-tree-walker.js';

const mockWalkActionTree = vi.mocked(walkActionTree);

function makeRepo(): ExecutionRepository {
  return {
    findExecution: vi.fn(),
    insertExecution: vi.fn(),
    insertSteps: vi.fn(),
    updateExecutionStatus: vi.fn(),
    updateStepStatus: vi.fn(),
    updateManyStepsStatus: vi.fn(),
    findStepById: vi.fn(),
  } as unknown as ExecutionRepository;
}

function makeQueue(): Queue<ActionJobData> {
  return {
    add: vi.fn().mockResolvedValue({}),
  } as unknown as Queue<ActionJobData>;
}

const baseEvent: InboundEvent = {
  event_id: 'evt-1',
  event_type: 'lead.created',
  entity_type: 'lead',
  entity_id: 'lead-123',
  payload: { foo: 'bar' },
};

const baseRule: MatchedRule = {
  rule: {
    rule_id: 'rule-1',
    rule_version: 2,
    action_tree: { type: 'emit_event', params: { event_type: 'x' } },
    condition: null,
    event_type: 'lead.created',
    name: 'Test Rule',
    is_active: true,
  } as unknown as MatchedRule['rule'],
  execCtx: {
    event_id: 'evt-1',
    execution_id: 'exec-placeholder',
    rule_id: 'rule-1',
    rule_version: 2,
  },
};

describe('ExecutionManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('idempotency', () => {
    it('returns early if execution already exists for event_id + rule_id', async () => {
      const repo = makeRepo();
      const queue = makeQueue();
      vi.mocked(repo.findExecution).mockResolvedValue({
        id: 'existing-exec',
      } as unknown as ReturnType<typeof repo.findExecution> extends Promise<infer T> ? T : never);

      const manager = new ExecutionManager(repo, queue);
      await manager.handle(baseRule, baseEvent);

      expect(repo.insertExecution).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('inserts execution, walks tree, bulk-inserts steps, enqueues root job', async () => {
      const repo = makeRepo();
      const queue = makeQueue();

      vi.mocked(repo.findExecution).mockResolvedValue(null);

      const insertedExecution = {
        id: 'exec-abc',
        rule_id: 'rule-1',
        rule_version: 2,
        status: 'running',
      };
      vi.mocked(repo.insertExecution).mockResolvedValue(insertedExecution as unknown as ReturnType<typeof repo.insertExecution> extends Promise<infer T> ? T : never);

      const steps = [
        { id: 'step-1', execution_id: 'exec-abc', action_type: 'emit_event', action_params: { event_type: 'x' }, status: 'pending' as const },
        { id: 'step-2', execution_id: 'exec-abc', action_type: 'enroll_sequence', action_params: {}, status: 'pending' as const },
      ];
      mockWalkActionTree.mockReturnValue(steps);

      const manager = new ExecutionManager(repo, queue);
      await manager.handle(baseRule, baseEvent);

      // insertExecution called with correct fields
      expect(repo.insertExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          rule_id: 'rule-1',
          rule_version: 2,
          action_tree_snapshot: baseRule.rule.action_tree,
          event_id: 'evt-1',
          event_type: 'lead.created',
          entity_type: 'lead',
          entity_id: 'lead-123',
        }),
      );

      // walkActionTree called with action_tree and execution id
      expect(mockWalkActionTree).toHaveBeenCalledWith(baseRule.rule.action_tree, 'exec-abc');

      // insertSteps called with walker output
      expect(repo.insertSteps).toHaveBeenCalledWith(steps);

      // queue.add called with root step data
      expect(queue.add).toHaveBeenCalledWith('emit_event', {
        execution_id: 'exec-abc',
        step_id: 'step-1',
        action_type: 'emit_event',
        action_params: { event_type: 'x' },
        exec_ctx: baseRule.execCtx,
        event: baseEvent,
        active_hours: null,
      });

      // updateExecutionStatus NOT called
      expect(repo.updateExecutionStatus).not.toHaveBeenCalled();
    });
  });

  describe('empty tree', () => {
    it('inserts steps with empty array, marks execution completed, does not enqueue', async () => {
      const repo = makeRepo();
      const queue = makeQueue();

      vi.mocked(repo.findExecution).mockResolvedValue(null);
      vi.mocked(repo.insertExecution).mockResolvedValue({
        id: 'exec-xyz',
        status: 'running',
      } as unknown as ReturnType<typeof repo.insertExecution> extends Promise<infer T> ? T : never);

      mockWalkActionTree.mockReturnValue([]);

      const manager = new ExecutionManager(repo, queue);
      await manager.handle(baseRule, baseEvent);

      expect(repo.insertSteps).toHaveBeenCalledWith([]);
      expect(repo.updateExecutionStatus).toHaveBeenCalledWith('exec-xyz', 'completed', expect.any(Date));
      expect(queue.add).not.toHaveBeenCalled();
    });
  });
});
