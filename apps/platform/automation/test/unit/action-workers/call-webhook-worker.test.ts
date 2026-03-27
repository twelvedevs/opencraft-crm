import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveHeaderSecrets, createCallWebhookProcessor } from '../../../src/services/action-workers/call-webhook.worker.js';
import type { ExecutionRepository } from '../../../src/repositories/execution.repository.js';
import type { Queue } from 'bullmq';
import type { ActionJobData } from '../../../src/queue/index.js';

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

function makeJob(overrides: Partial<ActionJobData> = {}): {
  data: ActionJobData;
  attemptsMade: number;
  token: string;
} {
  return {
    data: {
      execution_id: 'exec-1',
      step_id: 'step-1',
      action_type: 'call_webhook',
      action_params: {
        url: 'https://example.com/hook',
        body: { event: 'test' },
        ...((overrides['action_params'] as object | undefined) ?? {}),
      },
      exec_ctx: { event_id: 'evt-1', execution_id: 'exec-1', rule_id: 'rule-1', rule_version: 1 },
      event: {},
      active_hours: null,
      ...overrides,
    },
    attemptsMade: 0,
    token: 'tok-1',
  };
}

function makeOkResponse() {
  return { ok: true, json: vi.fn().mockResolvedValue({}) } as unknown as Response;
}

function makeErrorResponse(status: number) {
  return { ok: false, status, json: vi.fn() } as unknown as Response;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('resolveHeaderSecrets', () => {
  it('resolves {{my_secret}} pattern by calling secretsResolver', async () => {
    const secretsResolver = vi.fn().mockResolvedValue('super-secret-value');
    const result = await resolveHeaderSecrets({ Authorization: '{{my_secret}}' }, secretsResolver);
    expect(secretsResolver).toHaveBeenCalledWith('my_secret');
    expect(result['Authorization']).toBe('super-secret-value');
  });

  it('passes plain header values through unchanged', async () => {
    const secretsResolver = vi.fn();
    const result = await resolveHeaderSecrets({ 'X-Custom': 'plain-value' }, secretsResolver);
    expect(secretsResolver).not.toHaveBeenCalled();
    expect(result['X-Custom']).toBe('plain-value');
  });

  it('handles mixed headers — only secret-pattern values resolved', async () => {
    const secretsResolver = vi.fn().mockResolvedValue('resolved');
    const result = await resolveHeaderSecrets(
      { Authorization: '{{token}}', 'X-Plain': 'plain' },
      secretsResolver,
    );
    expect(secretsResolver).toHaveBeenCalledTimes(1);
    expect(secretsResolver).toHaveBeenCalledWith('token');
    expect(result['Authorization']).toBe('resolved');
    expect(result['X-Plain']).toBe('plain');
  });
});

describe('call_webhook processor — happy path', () => {
  it('no secrets, no next step — fetchFn called with correct args, step completed, updateExecutionStatus called', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const secretsResolver = vi.fn();
    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse());
    // Use values with hyphens/special chars so resolveParams doesn't treat them as dot-path references
    const job = makeJob({
      action_params: {
        url: 'https://example.com/hook',
        method: 'POST',
        headers: { 'X-Custom': 'static-header-value' },
        body: { key: 'literal-body-value' },
      },
    });

    const processor = createCallWebhookProcessor(repo, queue, secretsResolver, fetchFn);
    await processor(job as unknown as Parameters<typeof processor>[0]);

    expect(fetchFn).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json', 'X-Custom': 'static-header-value' }),
        body: JSON.stringify({ key: 'literal-body-value' }),
      }),
    );
    expect(repo.updateStepStatus).toHaveBeenCalledWith('step-1', 'completed', expect.objectContaining({ completedAt: expect.any(Date) }));
    expect(repo.updateExecutionStatus).toHaveBeenCalledWith('exec-1', 'completed', expect.any(Date));
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('with next step — step completed, queue.add called, updateExecutionStatus NOT called', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const secretsResolver = vi.fn();
    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse());
    const nextStep = {
      id: 'step-2',
      action_type: 'send_message',
      action_params: {},
      status: 'pending',
      execution_id: 'exec-1',
      output: null,
      attempt: 0,
      error: null,
      started_at: null,
      completed_at: null,
    };
    vi.mocked(repo.findStepById).mockResolvedValue(nextStep);

    const job = makeJob({
      action_params: {
        url: 'https://example.com/hook',
        body: {},
        _next_step_id: 'step-2',
      },
      active_hours: { start: '09:00', end: '17:00', timezone_field: 'tz' },
    } as unknown as Partial<ActionJobData>);

    const processor = createCallWebhookProcessor(repo, queue, secretsResolver, fetchFn);
    await processor(job as unknown as Parameters<typeof processor>[0]);

    expect(repo.updateStepStatus).toHaveBeenCalledWith('step-1', 'completed', expect.anything());
    expect(queue.add).toHaveBeenCalledWith(
      'send_message',
      expect.objectContaining({
        step_id: 'step-2',
        active_hours: job.data.active_hours,
      }),
    );
    expect(repo.updateExecutionStatus).not.toHaveBeenCalled();
  });
});

describe('call_webhook processor — timeout', () => {
  it('AbortError — step set to failed, updateExecutionStatus(failed) called, no throw, queue.add NOT called', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const secretsResolver = vi.fn();
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const fetchFn = vi.fn().mockRejectedValue(abortErr);
    const job = makeJob({
      action_params: {
        url: 'https://example.com/hook',
        body: {},
        timeout_ms: 3000,
      },
    });

    const processor = createCallWebhookProcessor(repo, queue, secretsResolver, fetchFn);
    await expect(processor(job as unknown as Parameters<typeof processor>[0])).resolves.toBeUndefined();

    expect(repo.updateStepStatus).toHaveBeenCalledWith('step-1', 'failed', { error: 'timeout after 3000ms' });
    expect(repo.updateExecutionStatus).toHaveBeenCalledWith('exec-1', 'failed', expect.any(Date));
    expect(queue.add).not.toHaveBeenCalled();
    expect(repo.updateStepStatus).not.toHaveBeenCalledWith('step-1', 'completed', expect.anything());
  });
});

describe('call_webhook processor — error cases', () => {
  it('non-ok HTTP response (500) — throws error containing "500", step NOT completed', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const secretsResolver = vi.fn();
    const fetchFn = vi.fn().mockResolvedValue(makeErrorResponse(500));
    const job = makeJob();

    const processor = createCallWebhookProcessor(repo, queue, secretsResolver, fetchFn);
    await expect(processor(job as unknown as Parameters<typeof processor>[0])).rejects.toThrow('500');

    expect(repo.updateStepStatus).not.toHaveBeenCalledWith('step-1', 'completed', expect.anything());
    expect(repo.updateExecutionStatus).not.toHaveBeenCalled();
  });

  it('non-timeout network error (ECONNREFUSED) — error is rethrown, step NOT completed', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const secretsResolver = vi.fn();
    const netErr = new Error('ECONNREFUSED');
    const fetchFn = vi.fn().mockRejectedValue(netErr);
    const job = makeJob();

    const processor = createCallWebhookProcessor(repo, queue, secretsResolver, fetchFn);
    await expect(processor(job as unknown as Parameters<typeof processor>[0])).rejects.toThrow('ECONNREFUSED');

    expect(repo.updateStepStatus).not.toHaveBeenCalledWith('step-1', 'completed', expect.anything());
  });

  it('default method is POST when method not in action_params', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const secretsResolver = vi.fn();
    const fetchFn = vi.fn().mockResolvedValue(makeOkResponse());
    const job = makeJob({
      action_params: { url: 'https://example.com/hook', body: {} },
    });

    const processor = createCallWebhookProcessor(repo, queue, secretsResolver, fetchFn);
    await processor(job as unknown as Parameters<typeof processor>[0]);

    expect(fetchFn).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('body is object → JSON.stringify applied; body is string → passed as-is', async () => {
    const repo = makeRepo();
    const queue = makeQueue();
    const secretsResolver = vi.fn();

    // Object body — value `42` is a number, not a string, so resolveParams won't treat it as a dot-path
    const fetchFn1 = vi.fn().mockResolvedValue(makeOkResponse());
    const job1 = makeJob({ action_params: { url: 'https://x.com', body: { a: 42 } } });
    const processor1 = createCallWebhookProcessor(repo, queue, secretsResolver, fetchFn1);
    await processor1(job1 as unknown as Parameters<typeof processor1>[0]);
    expect(fetchFn1.mock.calls[0][1].body).toBe(JSON.stringify({ a: 42 }));

    vi.resetAllMocks();

    // String body
    const fetchFn2 = vi.fn().mockResolvedValue(makeOkResponse());
    const repo2 = makeRepo();
    const job2 = makeJob({ action_params: { url: 'https://x.com', body: 'raw-string' } });
    const processor2 = createCallWebhookProcessor(repo2, makeQueue(), secretsResolver, fetchFn2);
    await processor2(job2 as unknown as Parameters<typeof processor2>[0]);
    expect(fetchFn2.mock.calls[0][1].body).toBe('raw-string');
  });
});
