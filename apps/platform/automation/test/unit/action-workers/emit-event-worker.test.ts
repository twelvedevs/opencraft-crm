import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEmitEventProcessor, EVENTBRIDGE_BUS_ENV } from '../../../src/services/action-workers/emit-event.worker.js';
import type { ExecutionRepository, Step } from '../../../src/repositories/execution.repository.js';
import type { ActionJobData } from '../../../src/queue/index.js';
import type { Job, Queue } from 'bullmq';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
  PutEventsCommand: vi.fn().mockImplementation((input) => input),
}));

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

function makeEbClient(): EventBridgeClient {
  return {
    send: vi.fn().mockResolvedValue({}),
  } as unknown as EventBridgeClient;
}

function makeJob(overrides: Partial<ActionJobData> = {}, attemptsMade = 0): Job<ActionJobData> {
  return {
    attemptsMade,
    data: {
      execution_id: 'exec-1',
      step_id: 'step-1',
      action_type: 'emit_event',
      action_params: {
        event_type: 'lead.updated',
        payload: { count: 1 },
      },
      exec_ctx: { event_id: 'e1', execution_id: 'exec-1', rule_id: 'r1', rule_version: 1 },
      event: { lead_id: 'lead-1' },
      active_hours: null,
      ...overrides,
    },
  } as unknown as Job<ActionJobData>;
}

function makeStep(id: string, action_type = 'enroll_sequence'): Step {
  return {
    id,
    execution_id: 'exec-1',
    action_type,
    action_params: { sequence_id: 'seq-1' },
    output: null,
    status: 'pending',
    attempt: 0,
    error: null,
    started_at: null,
    completed_at: null,
  };
}

describe('createEmitEventProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env[EVENTBRIDGE_BUS_ENV] = 'my-bus';
  });

  afterEach(() => {
    delete process.env[EVENTBRIDGE_BUS_ENV];
  });

  it('sends PutEventsCommand with correct Entries fields', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const ebClient = makeEbClient();

    const job = makeJob();
    const processor = createEmitEventProcessor(repo, queue, ebClient);
    await processor(job);

    expect(vi.mocked(ebClient.send)).toHaveBeenCalledOnce();
    const [command] = vi.mocked(ebClient.send).mock.calls[0];
    const entry = (command as unknown as { Entries: unknown[] }).Entries[0] as Record<string, string>;
    expect(entry.EventBusName).toBe('my-bus');
    expect(entry.Source).toBe('automation-engine');
    expect(entry.DetailType).toBe('lead.updated');
    expect(JSON.parse(entry.Detail)).toEqual({ count: 1 });
  });

  it('resolves payload field interpolation from event', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const ebClient = makeEbClient();

    const job = makeJob({
      action_params: {
        event_type: 'lead.enrolled',
        payload: { entity_id: 'payload.entity_id' },
      },
      event: { payload: { entity_id: 'lead-abc' } },
    });

    const processor = createEmitEventProcessor(repo, queue, ebClient);
    await processor(job);

    const [command] = vi.mocked(ebClient.send).mock.calls[0];
    const entry = (command as unknown as { Entries: unknown[] }).Entries[0] as Record<string, string>;
    const detail = JSON.parse(entry.Detail) as Record<string, unknown>;
    expect(detail.entity_id).toBe('lead-abc');
  });

  it('throws when EVENTBRIDGE_BUS_NAME env var is missing', async () => {
    delete process.env[EVENTBRIDGE_BUS_ENV];
    const repo = makeRepo();
    const queue = makeQueue();
    const ebClient = makeEbClient();

    const job = makeJob();
    const processor = createEmitEventProcessor(repo, queue, ebClient);

    await expect(processor(job)).rejects.toThrow('EVENTBRIDGE_BUS_NAME');
  });

  it('enqueues next step and does NOT complete execution when _next_step_id present', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const ebClient = makeEbClient();
    const nextStep = makeStep('step-2');
    vi.mocked(repo.findStepById).mockResolvedValue(nextStep);

    const activeHours = { start: '08:00', end: '20:00', timezone_field: 'payload.tz' };
    const job = makeJob({
      action_params: {
        event_type: 'lead.updated',
        payload: {},
        _next_step_id: 'step-2',
      },
      active_hours: activeHours,
    });

    const processor = createEmitEventProcessor(repo, queue, ebClient);
    await processor(job);

    expect(vi.mocked(repo.findStepById)).toHaveBeenCalledWith('step-2');
    expect(vi.mocked(queue.add)).toHaveBeenCalledWith(
      nextStep.action_type,
      expect.objectContaining({
        execution_id: 'exec-1',
        step_id: 'step-2',
        action_type: nextStep.action_type,
        active_hours: activeHours,
      }),
    );
    expect(vi.mocked(repo.updateExecutionStatus)).not.toHaveBeenCalled();
  });

  it('marks execution complete when no _next_step_id', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const ebClient = makeEbClient();

    const job = makeJob();
    const processor = createEmitEventProcessor(repo, queue, ebClient);
    await processor(job);

    expect(vi.mocked(repo.updateExecutionStatus)).toHaveBeenCalledWith('exec-1', 'completed', expect.any(Date));
    expect(vi.mocked(queue.add)).not.toHaveBeenCalled();
  });
});
