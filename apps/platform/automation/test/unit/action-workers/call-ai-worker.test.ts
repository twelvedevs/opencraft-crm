import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCallAiProcessor } from '../../../src/services/action-workers/call-ai.worker.js';
import type { ExecutionRepository } from '../../../src/repositories/execution.repository.js';
import type { Queue } from 'bullmq';
import type { ActionJobData } from '../../../src/queue/index.js';

vi.mock('../../../src/services/active-hours.js', () => ({
  computeDelay: vi.fn(),
}));

import { computeDelay } from '../../../src/services/active-hours.js';

const mockComputeDelay = vi.mocked(computeDelay);

function makeRepo(): ExecutionRepository {
  return {
    updateStepStatus: vi.fn().mockResolvedValue(undefined),
    updateExecutionStatus: vi.fn().mockResolvedValue(undefined),
    findStepById: vi.fn().mockResolvedValue(null),
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

function makeJob(overrides: Partial<ActionJobData> & { active_hours?: unknown } = {}): {
  data: ActionJobData;
  attemptsMade: number;
  token: string;
  moveToDelayed: ReturnType<typeof vi.fn>;
} {
  return {
    data: {
      execution_id: 'exec-1',
      step_id: 'step-1',
      action_type: 'call_ai',
      action_params: {
        prompt_id: 'prompt-abc',
        context: { name: 'Alice' },
        auto_send: false,
        ...((overrides as Record<string, unknown>)['action_params'] as object | undefined),
      },
      exec_ctx: { event_id: 'evt-1', execution_id: 'exec-1', rule_id: 'rule-1', rule_version: 1 },
      event: {},
      active_hours: null,
      ...(overrides as Partial<ActionJobData>),
    },
    attemptsMade: 0,
    token: 'tok-1',
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAiResponse(ai_draft = 'draft text') {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({ ai_draft }),
  } as unknown as Response;
}

function makeMsgResponse() {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({}),
  } as unknown as Response;
}

function makeErrorResponse(status: number) {
  return {
    ok: false,
    status,
    json: vi.fn(),
  } as unknown as Response;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env['AI_SERVICE_URL'] = 'http://ai-service';
  process.env['MESSAGING_SERVICE_URL'] = 'http://messaging-service';
});

describe('call-ai worker — auto_send: false', () => {
  it('with next step: fetches AI once, marks completed with output, enqueues next step', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const nextStep = { id: 'step-2', action_type: 'send_message', action_params: {}, status: 'pending', execution_id: 'exec-1', output: null, attempt: 0, error: null, started_at: null, completed_at: null };
    vi.mocked(repo.findStepById).mockResolvedValue(nextStep);

    const fetchFn = vi.fn().mockResolvedValue(makeAiResponse());
    const job = makeJob({
      action_params: {
        prompt_id: 'prompt-abc',
        context: { name: 'Alice' },
        auto_send: false,
        _next_step_id: 'step-2',
      },
    } as unknown as Partial<ActionJobData>);

    const processor = createCallAiProcessor(repo, queue, fetchFn);
    await processor(job as unknown as Parameters<typeof processor>[0]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith('http://ai-service/ai/complete', expect.objectContaining({ method: 'POST' }));

    expect(repo.updateStepStatus).toHaveBeenCalledWith('step-1', 'completed', expect.objectContaining({ output: { ai_draft: 'draft text' } }));
    expect(repo.findStepById).toHaveBeenCalledWith('step-2');
    expect(queue.add).toHaveBeenCalledWith('send_message', expect.objectContaining({ step_id: 'step-2' }));
    expect(repo.updateExecutionStatus).not.toHaveBeenCalled();
  });

  it('no next step: fetches AI once, marks completed, calls updateExecutionStatus', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const fetchFn = vi.fn().mockResolvedValue(makeAiResponse());
    const job = makeJob();

    const processor = createCallAiProcessor(repo, queue, fetchFn);
    await processor(job as unknown as Parameters<typeof processor>[0]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(repo.updateStepStatus).toHaveBeenCalledWith('step-1', 'completed', expect.objectContaining({ output: { ai_draft: 'draft text' } }));
    expect(repo.updateExecutionStatus).toHaveBeenCalledWith('exec-1', 'completed', expect.any(Date));
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('call-ai worker — auto_send: true', () => {
  it('autoSendRespectsActiveHours: false — computeDelay not called, fetch called twice (AI + Messaging)', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(makeAiResponse())
      .mockResolvedValueOnce(makeMsgResponse());

    const job = makeJob({
      action_params: {
        prompt_id: 'prompt-abc',
        context: {},
        auto_send: true,
        auto_send_respects_active_hours: false,
        to_field: '+15550001111',
        from_field: '+15559999999',
      },
    } as unknown as Partial<ActionJobData>);

    const processor = createCallAiProcessor(repo, queue, fetchFn);
    await processor(job as unknown as Parameters<typeof processor>[0]);

    expect(mockComputeDelay).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const msgCallBody = JSON.parse(fetchFn.mock.calls[1][1].body as string) as Record<string, unknown>;
    expect(msgCallBody).toMatchObject({
      to: '+15550001111',
      from: '+15559999999',
      body: 'draft text',
      dedup_key: 'evt-1-ai-autosend',
    });

    expect(repo.updateStepStatus).toHaveBeenLastCalledWith('step-1', 'completed', expect.objectContaining({ output: { ai_draft: 'draft text' } }));
  });

  it('autoSendRespectsActiveHours: true, delay > 0 — moveToDelayed called, AI fetched once, Messaging NOT called, step NOT completed', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    mockComputeDelay.mockReturnValue(60_000);

    const fetchFn = vi.fn().mockResolvedValueOnce(makeAiResponse());
    const job = makeJob({
      action_params: {
        prompt_id: 'p1',
        context: {},
        auto_send: true,
        auto_send_respects_active_hours: true,
      },
      active_hours: { start: '09:00', end: '17:00', timezone_field: 'tz' },
    } as unknown as Partial<ActionJobData>);

    const processor = createCallAiProcessor(repo, queue, fetchFn);
    await processor(job as unknown as Parameters<typeof processor>[0]);

    expect(mockComputeDelay).toHaveBeenCalled();
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'tok-1');
    expect(fetchFn).toHaveBeenCalledTimes(1); // AI only
    expect(repo.updateStepStatus).not.toHaveBeenCalledWith('step-1', 'completed', expect.anything());
  });

  it('autoSendRespectsActiveHours: true, delay = 0 — proceeds to Messaging send, step completed', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    mockComputeDelay.mockReturnValue(0);

    const fetchFn = vi.fn()
      .mockResolvedValueOnce(makeAiResponse())
      .mockResolvedValueOnce(makeMsgResponse());

    const job = makeJob({
      action_params: {
        prompt_id: 'p1',
        context: {},
        auto_send: true,
        auto_send_respects_active_hours: true,
        to_field: '+1',
        from_field: '+2',
      },
      active_hours: { start: '09:00', end: '17:00', timezone_field: 'tz' },
    } as unknown as Partial<ActionJobData>);

    const processor = createCallAiProcessor(repo, queue, fetchFn);
    await processor(job as unknown as Parameters<typeof processor>[0]);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(repo.updateStepStatus).toHaveBeenLastCalledWith('step-1', 'completed', expect.objectContaining({ output: { ai_draft: 'draft text' } }));
  });

  it('autoSendRespectsActiveHours: true, active_hours: null — computeDelay NOT called, proceeds to send', async () => {
    const repo = makeRepo();
    const queue = makeQueue();

    const fetchFn = vi.fn()
      .mockResolvedValueOnce(makeAiResponse())
      .mockResolvedValueOnce(makeMsgResponse());

    const job = makeJob({
      action_params: {
        prompt_id: 'p1',
        context: {},
        auto_send: true,
        auto_send_respects_active_hours: true,
        to_field: '+1',
        from_field: '+2',
      },
      active_hours: null,
    } as unknown as Partial<ActionJobData>);

    const processor = createCallAiProcessor(repo, queue, fetchFn);
    await processor(job as unknown as Parameters<typeof processor>[0]);

    expect(mockComputeDelay).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('call-ai worker — error cases', () => {
  it('AI_SERVICE_URL not set → throws containing "AI_SERVICE_URL", step NOT completed', async () => {
    delete process.env['AI_SERVICE_URL'];
    const repo = makeRepo();
    const queue = makeQueue();
    const fetchFn = vi.fn();
    const job = makeJob();

    const processor = createCallAiProcessor(repo, queue, fetchFn);
    await expect(processor(job as unknown as Parameters<typeof processor>[0])).rejects.toThrow('AI_SERVICE_URL');

    expect(repo.updateStepStatus).not.toHaveBeenCalledWith('step-1', 'completed', expect.anything());
  });

  it('AI Service non-ok → throws containing status code, step NOT completed, Messaging NOT called', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const fetchFn = vi.fn().mockResolvedValue(makeErrorResponse(503));
    const job = makeJob();

    const processor = createCallAiProcessor(repo, queue, fetchFn);
    await expect(processor(job as unknown as Parameters<typeof processor>[0])).rejects.toThrow('503');

    expect(repo.updateStepStatus).not.toHaveBeenCalledWith('step-1', 'completed', expect.anything());
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('auto_send: true, MESSAGING_SERVICE_URL not set → AI called, then throws "MESSAGING_SERVICE_URL", step NOT completed', async () => {
    delete process.env['MESSAGING_SERVICE_URL'];
    const repo = makeRepo();
    const queue = makeQueue();
    const fetchFn = vi.fn().mockResolvedValueOnce(makeAiResponse());
    const job = makeJob({
      action_params: {
        prompt_id: 'p1',
        context: {},
        auto_send: true,
        auto_send_respects_active_hours: false,
      },
    } as unknown as Partial<ActionJobData>);

    const processor = createCallAiProcessor(repo, queue, fetchFn);
    await expect(processor(job as unknown as Parameters<typeof processor>[0])).rejects.toThrow('MESSAGING_SERVICE_URL');

    expect(fetchFn).toHaveBeenCalledTimes(1); // AI only
    expect(repo.updateStepStatus).not.toHaveBeenCalledWith('step-1', 'completed', expect.anything());
  });

  it('auto_send: true, Messaging non-ok → throws containing status code, step NOT completed', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(makeAiResponse())
      .mockResolvedValueOnce(makeErrorResponse(500));

    const job = makeJob({
      action_params: {
        prompt_id: 'p1',
        context: {},
        auto_send: true,
        auto_send_respects_active_hours: false,
      },
    } as unknown as Partial<ActionJobData>);

    const processor = createCallAiProcessor(repo, queue, fetchFn);
    await expect(processor(job as unknown as Parameters<typeof processor>[0])).rejects.toThrow('500');

    expect(repo.updateStepStatus).not.toHaveBeenCalledWith('step-1', 'completed', expect.anything());
  });
});
