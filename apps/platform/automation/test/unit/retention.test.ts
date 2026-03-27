import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RetentionService } from '../../src/services/retention.js';
import type { ExecutionRepository } from '../../src/repositories/execution.repository.js';

function makeRepo(deleteCount = 5): ExecutionRepository {
  return {
    deleteExecutionsBefore: vi.fn().mockResolvedValue(deleteCount),
  } as unknown as ExecutionRepository;
}

describe('RetentionService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env['EXECUTION_LOG_RETENTION_DAYS'];
  });

  it('cleanup() calls deleteExecutionsBefore with cutoff ~90 days ago when env var absent', async () => {
    const repo = makeRepo(3);
    const svc = new RetentionService(repo);

    const before = Date.now();
    await svc.cleanup();
    const after = Date.now();

    const expectedMs = 90 * 24 * 60 * 60 * 1000;
    const [cutoff] = (repo.deleteExecutionsBefore as ReturnType<typeof vi.fn>).mock.calls[0] as [Date];
    const cutoffMs = cutoff.getTime();

    expect(cutoffMs).toBeGreaterThanOrEqual(before - expectedMs - 1000);
    expect(cutoffMs).toBeLessThanOrEqual(after - expectedMs + 1000);
  });

  it('cleanup() uses EXECUTION_LOG_RETENTION_DAYS env var when set', async () => {
    process.env['EXECUTION_LOG_RETENTION_DAYS'] = '30';
    const repo = makeRepo(0);
    const svc = new RetentionService(repo);

    const before = Date.now();
    await svc.cleanup();
    const after = Date.now();

    const expectedMs = 30 * 24 * 60 * 60 * 1000;
    const [cutoff] = (repo.deleteExecutionsBefore as ReturnType<typeof vi.fn>).mock.calls[0] as [Date];
    const cutoffMs = cutoff.getTime();

    expect(cutoffMs).toBeGreaterThanOrEqual(before - expectedMs - 1000);
    expect(cutoffMs).toBeLessThanOrEqual(after - expectedMs + 1000);
  });

  it('cleanup() returns { deleted: N } from repo mock', async () => {
    const repo = makeRepo(7);
    const svc = new RetentionService(repo);

    const result = await svc.cleanup();

    expect(result).toEqual({ deleted: 7 });
  });

  it('start() runs cleanup immediately and returns a stop function that prevents further runs', async () => {
    const repo = makeRepo(0);
    const svc = new RetentionService(repo);

    const stop = svc.start(1000);

    // Allow initial fire-and-forget microtask to settle
    await Promise.resolve();

    expect(repo.deleteExecutionsBefore).toHaveBeenCalledTimes(1);

    stop();

    // Advance timer past one interval — should NOT trigger another cleanup
    await vi.advanceTimersByTimeAsync(2000);

    expect(repo.deleteExecutionsBefore).toHaveBeenCalledTimes(1);
  });
});
