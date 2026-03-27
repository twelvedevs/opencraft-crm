import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSendMessageProcessor,
  TEMPLATE_SERVICE_URL_ENV,
  MESSAGING_SERVICE_URL_ENV,
} from '../../../src/services/action-workers/send-message.worker.js';
import type { ExecutionRepository, Step } from '../../../src/repositories/execution.repository.js';
import type { ActionJobData } from '../../../src/queue/index.js';
import type { Job, Queue } from 'bullmq';

vi.mock('../../../src/services/active-hours.js', () => ({
  computeDelay: vi.fn(),
}));

import { computeDelay } from '../../../src/services/active-hours.js';

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

function makeJob(overrides: Partial<ActionJobData> = {}, attemptsMade = 0): Job<ActionJobData> & { moveToDelayed: ReturnType<typeof vi.fn> } {
  return {
    attemptsMade,
    token: 'test-token',
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
    data: {
      execution_id: 'exec-1',
      step_id: 'step-1',
      action_type: 'send_message',
      action_params: {
        template_id: 'tpl-1',
        to_field: '+15550001111',
        from_field: '+15559999',
        context: { name: 'Jane' },
        dedup_key: 'dedup-abc',
      },
      exec_ctx: { event_id: 'e1', execution_id: 'exec-1', rule_id: 'r1', rule_version: 1 },
      event: { lead_id: 'lead-1' },
      active_hours: null,
      ...overrides,
    },
  } as unknown as Job<ActionJobData> & { moveToDelayed: ReturnType<typeof vi.fn> };
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

function makeSuccessFetch(): typeof fetch {
  return vi.fn()
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ body_text: 'Hello Jane!' }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
    } as Response) as unknown as typeof fetch;
}

describe('createSendMessageProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env[TEMPLATE_SERVICE_URL_ENV] = 'http://template:3000';
    process.env[MESSAGING_SERVICE_URL_ENV] = 'http://messaging:3000';
  });

  afterEach(() => {
    delete process.env[TEMPLATE_SERVICE_URL_ENV];
    delete process.env[MESSAGING_SERVICE_URL_ENV];
  });

  it('active hours: delay > 0 → moveToDelayed called, updateStepStatus(running) NOT called, fetchFn NOT called', async () => {
    vi.mocked(computeDelay).mockReturnValue(60_000);

    const repo = makeRepo();
    const queue = makeQueue();
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const job = makeJob({ active_hours: { start: '08:00', end: '20:00', timezone_field: 'payload.tz' } });

    const processor = createSendMessageProcessor(repo, queue, fetchFn);
    await processor(job);

    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'test-token');
    expect(vi.mocked(repo.updateStepStatus)).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('active hours: delay === 0 → proceeds normally', async () => {
    vi.mocked(computeDelay).mockReturnValue(0);

    const repo = makeRepo();
    const queue = makeQueue();
    const fetchFn = makeSuccessFetch();
    const job = makeJob({ active_hours: { start: '08:00', end: '20:00', timezone_field: 'payload.tz' } });

    const processor = createSendMessageProcessor(repo, queue, fetchFn);
    await processor(job);

    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(vi.mocked(repo.updateStepStatus)).toHaveBeenCalledWith('step-1', 'running', expect.anything());
  });

  it('no active_hours (null) → computeDelay NOT called, proceeds normally', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const fetchFn = makeSuccessFetch();
    const job = makeJob({ active_hours: null });

    const processor = createSendMessageProcessor(repo, queue, fetchFn);
    await processor(job);

    expect(computeDelay).not.toHaveBeenCalled();
    expect(vi.mocked(repo.updateStepStatus)).toHaveBeenCalledWith('step-1', 'running', expect.anything());
  });

  it('happy path with next step — two fetches, step completed, queue.add called, updateExecutionStatus NOT called', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const fetchFn = makeSuccessFetch();
    const nextStep = makeStep('step-2');
    vi.mocked(repo.findStepById).mockResolvedValue(nextStep);

    const activeHours = { start: '08:00', end: '20:00', timezone_field: 'payload.tz' };
    vi.mocked(computeDelay).mockReturnValue(0);

    const job = makeJob({
      action_params: {
        template_id: 'tpl-1',
        to_field: '+15550001111',
        from_field: '+15559999',
        context: { name: 'Jane' },
        dedup_key: 'dedup-abc',
        _next_step_id: 'step-2',
      },
      active_hours: activeHours,
    });

    const processor = createSendMessageProcessor(repo, queue, fetchFn);
    await processor(job);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(repo.updateStepStatus)).toHaveBeenCalledWith('step-1', 'completed', expect.anything());
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

  it('happy path without next step — two fetches, step completed, updateExecutionStatus called, queue.add NOT called', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const fetchFn = makeSuccessFetch();
    const job = makeJob();

    const processor = createSendMessageProcessor(repo, queue, fetchFn);
    await processor(job);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(repo.updateStepStatus)).toHaveBeenCalledWith('step-1', 'completed', expect.anything());
    expect(vi.mocked(repo.updateExecutionStatus)).toHaveBeenCalledWith('exec-1', 'completed', expect.any(Date));
    expect(vi.mocked(queue.add)).not.toHaveBeenCalled();
  });

  it('missing dedup_key — console.warn called, msgPayload sent without dedup_key, execution still completes', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const repo = makeRepo();
    const queue = makeQueue();
    const fetchFn = makeSuccessFetch();
    const job = makeJob({
      action_params: {
        template_id: 'tpl-1',
        to_field: '+15550001111',
        from_field: '+15559999',
        context: { name: 'Jane' },
        // no dedup_key
      },
    });

    const processor = createSendMessageProcessor(repo, queue, fetchFn);
    await processor(job);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('step-1'));
    const [, msgInit] = vi.mocked(fetchFn as ReturnType<typeof vi.fn>).mock.calls[1];
    const msgBody = JSON.parse((msgInit as RequestInit).body as string) as Record<string, unknown>;
    expect(msgBody).not.toHaveProperty('dedup_key');
    expect(vi.mocked(repo.updateExecutionStatus)).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('TEMPLATE_SERVICE_URL not set → throws containing TEMPLATE_SERVICE_URL', async () => {
    delete process.env[TEMPLATE_SERVICE_URL_ENV];
    const repo = makeRepo();
    const queue = makeQueue();
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const job = makeJob();

    const processor = createSendMessageProcessor(repo, queue, fetchFn);
    await expect(processor(job)).rejects.toThrow('TEMPLATE_SERVICE_URL');
  });

  it('MESSAGING_SERVICE_URL not set → throws containing MESSAGING_SERVICE_URL', async () => {
    delete process.env[MESSAGING_SERVICE_URL_ENV];
    const repo = makeRepo();
    const queue = makeQueue();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ body_text: 'Hello!' }),
      } as Response) as unknown as typeof fetch;
    const job = makeJob();

    const processor = createSendMessageProcessor(repo, queue, fetchFn);
    await expect(processor(job)).rejects.toThrow('MESSAGING_SERVICE_URL');
  });

  it('template render returns non-ok status → throws containing status, updateStepStatus(completed) NOT called', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    } as Response) as unknown as typeof fetch;
    const job = makeJob();

    const processor = createSendMessageProcessor(repo, queue, fetchFn);
    await expect(processor(job)).rejects.toThrow('500');

    const completedCalls = vi.mocked(repo.updateStepStatus).mock.calls.filter(([, s]) => s === 'completed');
    expect(completedCalls).toHaveLength(0);
  });

  it('messages/send returns non-ok status → throws containing status, updateStepStatus(completed) NOT called', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ body_text: 'Hello!' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
      } as Response) as unknown as typeof fetch;
    const job = makeJob();

    const processor = createSendMessageProcessor(repo, queue, fetchFn);
    await expect(processor(job)).rejects.toThrow('503');

    const completedCalls = vi.mocked(repo.updateStepStatus).mock.calls.filter(([, s]) => s === 'completed');
    expect(completedCalls).toHaveLength(0);
  });
});
