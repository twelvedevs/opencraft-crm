import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    listenerCount: vi.fn(),
  })),
}));

import { Worker } from 'bullmq';
import { RETRY_DELAYS, createActionWorker } from '../../src/queue/worker-factory.js';
import type { ActionJobData } from '../../src/queue/index.js';

const MockWorker = vi.mocked(Worker);

function getWorkerArgs() {
  const call = MockWorker.mock.calls[0];
  const [queueName, processor, options] = call as [string, unknown, { connection: object; settings: { backoffStrategy: (n: number) => number } }];
  return { queueName, processor, options };
}

function getOnHandler(mockWorkerInstance: ReturnType<typeof MockWorker.mock.results[0]['value']>, event: string) {
  const onMock = vi.mocked(mockWorkerInstance.on);
  const call = onMock.mock.calls.find(([e]) => e === event);
  if (!call) throw new Error(`No '${event}' handler registered`);
  return call[1] as (...args: unknown[]) => void;
}

function makeJob(overrides: Partial<{
  attemptsMade: number;
  opts: { attempts: number };
  data: ActionJobData;
}> = {}) {
  return {
    attemptsMade: overrides.attemptsMade ?? 1,
    opts: overrides.opts ?? { attempts: 4 },
    data: overrides.data ?? {
      execution_id: 'exec-1',
      step_id: 'step-1',
      action_type: 'emit_event',
      action_params: {},
      exec_ctx: { event_id: 'e1', execution_id: 'exec-1', rule_id: 'r1', rule_version: 1 },
      event: {},
    },
  };
}

describe('RETRY_DELAYS', () => {
  it('is exactly [5000, 30000, 120000, 600000]', () => {
    expect(RETRY_DELAYS).toEqual([5000, 30000, 120000, 600000]);
  });
});

describe('createActionWorker', () => {
  beforeEach(() => {
    MockWorker.mockClear();
  });

  it('calls new Worker with correct queueName and settings.backoffStrategy', () => {
    const processor = vi.fn();
    const connection = { host: 'localhost', port: 6379 };
    createActionWorker('test-queue', connection, processor);

    expect(MockWorker).toHaveBeenCalledOnce();
    const { queueName, options } = getWorkerArgs();
    expect(queueName).toBe('test-queue');
    expect(typeof options.settings.backoffStrategy).toBe('function');
  });

  describe('backoffStrategy', () => {
    it('returns correct delays for each attempt', () => {
      const processor = vi.fn();
      createActionWorker('test-queue', {}, processor);
      const { options } = getWorkerArgs();
      const strategy = options.settings.backoffStrategy;

      expect(strategy(1)).toBe(5000);
      expect(strategy(2)).toBe(30000);
      expect(strategy(3)).toBe(120000);
      expect(strategy(4)).toBe(600000);
    });

    it('clamps to last value for out-of-bounds attempts', () => {
      const processor = vi.fn();
      createActionWorker('test-queue', {}, processor);
      const { options } = getWorkerArgs();
      const strategy = options.settings.backoffStrategy;

      expect(strategy(99)).toBe(600000);
    });
  });

  describe("'failed' handler", () => {
    it('emits DLQ alert on final failure (attemptsMade === opts.attempts)', () => {
      const logger = { error: vi.fn() };
      const processor = vi.fn();
      const worker = createActionWorker('my-queue', {}, processor, logger);

      const handler = getOnHandler(worker as unknown as ReturnType<typeof MockWorker.mock.results[0]['value']>, 'failed');
      const job = makeJob({ attemptsMade: 4, opts: { attempts: 4 } });

      handler(job, new Error('something broke'));

      expect(logger.error).toHaveBeenCalledOnce();
      const logged = JSON.parse(vi.mocked(logger.error).mock.calls[0][0] as string);
      expect(logged).toMatchObject({
        alert: 'automation_dlq',
        queue: 'my-queue',
        execution_id: 'exec-1',
        step_id: 'step-1',
        action_type: 'emit_event',
        error: 'something broke',
      });
    });

    it('does NOT emit alert on non-final failure (attemptsMade < opts.attempts)', () => {
      const logger = { error: vi.fn() };
      const processor = vi.fn();
      const worker = createActionWorker('my-queue', {}, processor, logger);

      const handler = getOnHandler(worker as unknown as ReturnType<typeof MockWorker.mock.results[0]['value']>, 'failed');
      const job = makeJob({ attemptsMade: 1, opts: { attempts: 4 } });

      handler(job, new Error('transient'));

      expect(logger.error).not.toHaveBeenCalled();
    });

    it('does NOT throw when job is undefined', () => {
      const logger = { error: vi.fn() };
      const processor = vi.fn();
      const worker = createActionWorker('my-queue', {}, processor, logger);

      const handler = getOnHandler(worker as unknown as ReturnType<typeof MockWorker.mock.results[0]['value']>, 'failed');

      expect(() => handler(undefined, new Error('no job'))).not.toThrow();
      expect(logger.error).not.toHaveBeenCalled();
    });
  });
});
