import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/condition-evaluator.js', () => ({
  evaluate: vi.fn(),
}));

import { evaluate } from '../../../src/services/condition-evaluator.js';
import { createBranchProcessor } from '../../../src/services/action-workers/branch.worker.js';
import type { ExecutionRepository, Step } from '../../../src/repositories/execution.repository.js';
import type { ActionJobData } from '../../../src/queue/index.js';
import type { Job, Queue } from 'bullmq';

const mockEvaluate = vi.mocked(evaluate);

function makeRepo(): ExecutionRepository {
  return {
    updateStepStatus: vi.fn().mockResolvedValue(undefined),
    updateManyStepsStatus: vi.fn().mockResolvedValue(undefined),
    findStepById: vi.fn(),
    insertExecution: vi.fn(),
    findExecution: vi.fn(),
    insertSteps: vi.fn(),
    updateExecutionStatus: vi.fn(),
  } as unknown as ExecutionRepository;
}

function makeQueue(): Queue<ActionJobData> {
  return {
    add: vi.fn().mockResolvedValue(undefined),
  } as unknown as Queue<ActionJobData>;
}

function makeJob(overrides: Partial<ActionJobData> = {}, attemptsMade = 0): Job<ActionJobData> {
  return {
    attemptsMade,
    data: {
      execution_id: 'exec-1',
      step_id: 'branch-step-1',
      action_type: 'branch',
      action_params: {
        condition: { field: 'event.status', op: 'eq', value: 'active' },
        _if_true_step_id: 'true-step-1',
        _if_false_step_id: 'false-step-1',
        _if_true_subtree_ids: ['true-step-1', 'true-step-2'],
        _if_false_subtree_ids: ['false-step-1'],
      },
      exec_ctx: { event_id: 'e1', execution_id: 'exec-1', rule_id: 'r1', rule_version: 1 },
      event: { status: 'active' },
      active_hours: null,
      ...overrides,
    },
  } as unknown as Job<ActionJobData>;
}

function makeStep(id: string, action_type = 'send_message'): Step {
  return {
    id,
    execution_id: 'exec-1',
    action_type,
    action_params: { template_id: 'tpl-1' },
    output: null,
    status: 'pending',
    attempt: 0,
    error: null,
    started_at: null,
    completed_at: null,
  };
}

describe('createBranchProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('condition true → skips false subtree, enqueues true winner', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    mockEvaluate.mockReturnValue(true);
    const winnerStep = makeStep('true-step-1');
    vi.mocked(repo.findStepById).mockResolvedValue(winnerStep);

    const activeHours = { start: '08:00', end: '20:00', timezone_field: 'payload.tz' };
    const processor = createBranchProcessor(repo, queue);
    const job = makeJob({ active_hours: activeHours });
    await processor(job);

    expect(vi.mocked(repo.updateManyStepsStatus)).toHaveBeenCalledWith(['false-step-1'], 'skipped');
    expect(vi.mocked(repo.findStepById)).toHaveBeenCalledWith('true-step-1');
    expect(vi.mocked(queue.add)).toHaveBeenCalledWith(
      winnerStep.action_type,
      expect.objectContaining({
        execution_id: 'exec-1',
        step_id: 'true-step-1',
        action_type: winnerStep.action_type,
        active_hours: activeHours,
      }),
    );
  });

  it('condition false → skips true subtree, enqueues false winner', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    mockEvaluate.mockReturnValue(false);
    const winnerStep = makeStep('false-step-1', 'emit_event');
    vi.mocked(repo.findStepById).mockResolvedValue(winnerStep);

    const processor = createBranchProcessor(repo, queue);
    const job = makeJob();
    await processor(job);

    expect(vi.mocked(repo.updateManyStepsStatus)).toHaveBeenCalledWith(
      ['true-step-1', 'true-step-2'],
      'skipped',
    );
    expect(vi.mocked(repo.findStepById)).toHaveBeenCalledWith('false-step-1');
    expect(vi.mocked(queue.add)).toHaveBeenCalledWith(
      'emit_event',
      expect.objectContaining({ step_id: 'false-step-1' }),
    );
  });

  it('throws when findStepById returns null', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    mockEvaluate.mockReturnValue(true);
    vi.mocked(repo.findStepById).mockResolvedValue(null);

    const processor = createBranchProcessor(repo, queue);
    const job = makeJob();

    await expect(processor(job)).rejects.toThrow('Branch winner step not found: true-step-1');
  });

  it('updateStepStatus running is called BEFORE evaluate', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const callOrder: string[] = [];

    vi.mocked(repo.updateStepStatus).mockImplementation(async (_id, status) => {
      if (status === 'running') callOrder.push('updateStepStatus:running');
    });
    mockEvaluate.mockImplementation(() => {
      callOrder.push('evaluate');
      return true;
    });
    const winnerStep = makeStep('true-step-1');
    vi.mocked(repo.findStepById).mockResolvedValue(winnerStep);

    const processor = createBranchProcessor(repo, queue);
    await processor(makeJob());

    expect(callOrder.indexOf('updateStepStatus:running')).toBeLessThan(
      callOrder.indexOf('evaluate'),
    );
  });

  it('updateStepStatus completed is called AFTER queue.add', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const callOrder: string[] = [];

    vi.mocked(queue.add).mockImplementation(async () => {
      callOrder.push('queue.add');
      return {} as never;
    });
    vi.mocked(repo.updateStepStatus).mockImplementation(async (_id, status) => {
      if (status === 'completed') callOrder.push('updateStepStatus:completed');
    });
    mockEvaluate.mockReturnValue(true);
    const winnerStep = makeStep('true-step-1');
    vi.mocked(repo.findStepById).mockResolvedValue(winnerStep);

    const processor = createBranchProcessor(repo, queue);
    await processor(makeJob());

    expect(callOrder.indexOf('queue.add')).toBeLessThan(
      callOrder.indexOf('updateStepStatus:completed'),
    );
  });
});
