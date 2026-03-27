import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEnrollSequenceProcessor, ENROLL_SEQUENCE_URL_ENV } from '../../../src/services/action-workers/enroll-sequence.worker.js';
import type { ExecutionRepository, Step } from '../../../src/repositories/execution.repository.js';
import type { ActionJobData } from '../../../src/queue/index.js';
import type { Job, Queue } from 'bullmq';

function makeRepo(): ExecutionRepository {
  return {
    updateStepStatus: vi.fn().mockResolvedValue(undefined),
    updateExecutionStatus: vi.fn().mockResolvedValue(undefined),
    findStepById: vi.fn(),
    insertExecution: vi.fn(),
    findExecution: vi.fn(),
    insertSteps: vi.fn(),
    updateManyStepsStatus: vi.fn(),
  } as unknown as ExecutionRepository;
}

function makeQueue(): Queue<ActionJobData> {
  return {
    add: vi.fn().mockResolvedValue(undefined),
  } as unknown as Queue<ActionJobData>;
}

function makeFetch(ok = true, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({ ok, status } as Response);
}

function makeJob(overrides: Partial<ActionJobData> = {}, attemptsMade = 0): Job<ActionJobData> {
  return {
    attemptsMade,
    data: {
      execution_id: 'exec-1',
      step_id: 'step-1',
      action_type: 'enroll_sequence',
      action_params: {
        sequence_id: 'seq-abc',
        entity_id: 'lead-1',
      },
      exec_ctx: { event_id: 'e1', execution_id: 'exec-1', rule_id: 'r1', rule_version: 1 },
      event: { lead_id: 'lead-1' },
      ...overrides,
    },
  } as unknown as Job<ActionJobData>;
}

function makeStep(id: string, action_type = 'emit_event'): Step {
  return {
    id,
    execution_id: 'exec-1',
    action_type,
    action_params: { event_type: 'lead.enrolled' },
    output: null,
    status: 'pending',
    attempt: 0,
    error: null,
    started_at: null,
    completed_at: null,
  };
}

describe('createEnrollSequenceProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env[ENROLL_SEQUENCE_URL_ENV] = 'http://nurturing:3000';
  });

  afterEach(() => {
    delete process.env[ENROLL_SEQUENCE_URL_ENV];
  });

  it('happy path WITH _next_step_id — fetches, completes step, enqueues next', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const fetchFn = makeFetch();
    const nextStep = makeStep('step-2');
    vi.mocked(repo.findStepById).mockResolvedValue(nextStep);

    const job = makeJob({
      action_params: {
        sequence_id: 'seq-abc',
        _next_step_id: 'step-2',
      },
    });

    const processor = createEnrollSequenceProcessor(repo, queue, fetchFn);
    await processor(job);

    expect(fetchFn).toHaveBeenCalledWith(
      'http://nurturing:3000/sequences/enroll',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(vi.mocked(repo.updateStepStatus)).toHaveBeenCalledWith('step-1', 'completed', expect.anything());
    expect(vi.mocked(repo.findStepById)).toHaveBeenCalledWith('step-2');
    expect(vi.mocked(queue.add)).toHaveBeenCalledWith(
      nextStep.action_type,
      expect.objectContaining({
        execution_id: 'exec-1',
        step_id: 'step-2',
        action_type: nextStep.action_type,
      }),
    );
    expect(vi.mocked(repo.updateExecutionStatus)).not.toHaveBeenCalled();
  });

  it('happy path WITHOUT _next_step_id — fetches, completes step, marks execution complete', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const fetchFn = makeFetch();

    const job = makeJob();
    const processor = createEnrollSequenceProcessor(repo, queue, fetchFn);
    await processor(job);

    expect(fetchFn).toHaveBeenCalled();
    expect(vi.mocked(repo.updateStepStatus)).toHaveBeenCalledWith('step-1', 'completed', expect.anything());
    expect(vi.mocked(repo.updateExecutionStatus)).toHaveBeenCalledWith('exec-1', 'completed', expect.any(Date));
    expect(vi.mocked(queue.add)).not.toHaveBeenCalled();
  });

  it('HTTP error — throws Error containing status', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const fetchFn = makeFetch(false, 503);

    const job = makeJob();
    const processor = createEnrollSequenceProcessor(repo, queue, fetchFn);

    await expect(processor(job)).rejects.toThrow('503');
  });

  it('missing env var — throws Error containing NURTURING_ENGINE_URL', async () => {
    delete process.env[ENROLL_SEQUENCE_URL_ENV];
    const repo = makeRepo();
    const queue = makeQueue();
    const fetchFn = makeFetch();

    const job = makeJob();
    const processor = createEnrollSequenceProcessor(repo, queue, fetchFn);

    await expect(processor(job)).rejects.toThrow('NURTURING_ENGINE_URL');
  });

  it('routing keys stripped from POST body', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const fetchFn = makeFetch();
    vi.mocked(repo.findStepById).mockResolvedValue(makeStep('step-2'));

    const job = makeJob({
      action_params: {
        sequence_id: 'seq-abc',
        _next_step_id: 'step-2',
        _if_true_step_id: 'true-step',
        _if_false_step_id: 'false-step',
        _if_true_subtree_ids: ['true-step'],
        _if_false_subtree_ids: ['false-step'],
      },
    });

    const processor = createEnrollSequenceProcessor(repo, queue, fetchFn);
    await processor(job);

    const [, init] = vi.mocked(fetchFn).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('_next_step_id');
    expect(body).not.toHaveProperty('_if_true_step_id');
    expect(body).not.toHaveProperty('_if_false_step_id');
    expect(body).not.toHaveProperty('_if_true_subtree_ids');
    expect(body).not.toHaveProperty('_if_false_subtree_ids');
    expect(body).toHaveProperty('sequence_id', 'seq-abc');
  });

  it('field interpolation applied — resolves dot-path values from event', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const fetchFn = makeFetch();

    const job = makeJob({
      action_params: {
        sequence_id: 'seq-abc',
        entity_id: 'payload.entity_id',
      },
      event: { payload: { entity_id: 'lead-123' } },
    });

    const processor = createEnrollSequenceProcessor(repo, queue, fetchFn);
    await processor(job);

    const [, init] = vi.mocked(fetchFn).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toHaveProperty('entity_id', 'lead-123');
  });
});
