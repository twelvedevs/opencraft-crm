import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Knex } from 'knex';

// ---------------------------------------------------------------------------
// Hoisted mock handles — referenced inside vi.mock factories
// ---------------------------------------------------------------------------

const mockAdd = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockGetRepeatableJobs = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockRemoveRepeatableByKey = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const mockFindAllActive = vi.hoisted(() => vi.fn().mockResolvedValue([]));

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports
// ---------------------------------------------------------------------------

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: mockAdd,
    getRepeatableJobs: mockGetRepeatableJobs,
    removeRepeatableByKey: mockRemoveRepeatableByKey,
  })),
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/env.js', () => ({
  env: {
    REDIS_URL: 'redis://localhost:6379',
  },
}));

vi.mock('../../src/repositories/schedules.js', () => ({
  findAllActive: mockFindAllActive,
}));

import { registerSchedule, reconcile } from '../../src/services/schedule-manager.js';
import type { ReportSchedule } from '../../src/repositories/schedules.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSchedule(overrides: Partial<ReportSchedule> = {}): ReportSchedule {
  return {
    id: 'sched-1',
    report_config_id: 'config-1',
    frequency: 'daily',
    day_of_week: null,
    day_of_month: null,
    hour_utc: 0,
    recipient_emails: ['recipient@example.com'],
    format: 'pdf',
    active: true,
    created_by: 'user-1',
    created_at: new Date(),
    ...overrides,
  };
}

const fakeDb = {} as Knex;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  mockAdd.mockResolvedValue({});
  mockGetRepeatableJobs.mockResolvedValue([]);
  mockRemoveRepeatableByKey.mockResolvedValue(true);
  mockFindAllActive.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Cron expression derivation
// ---------------------------------------------------------------------------

describe('cron derivation via registerSchedule', () => {
  it('daily with hour_utc=14 → "0 14 * * *"', async () => {
    await registerSchedule(makeSchedule({ frequency: 'daily', hour_utc: 14 }));

    const [, , opts] = mockAdd.mock.calls[0] as [string, unknown, { repeat: { pattern: string }; jobId: string }];
    expect(opts.repeat.pattern).toBe('0 14 * * *');
  });

  it('weekly with hour_utc=9 and day_of_week=1 → "0 9 * * 1"', async () => {
    await registerSchedule(
      makeSchedule({ frequency: 'weekly', hour_utc: 9, day_of_week: 1 }),
    );

    const [, , opts] = mockAdd.mock.calls[0] as [string, unknown, { repeat: { pattern: string }; jobId: string }];
    expect(opts.repeat.pattern).toBe('0 9 * * 1');
  });

  it('monthly with hour_utc=8 and day_of_month=15 → "0 8 15 * *"', async () => {
    await registerSchedule(
      makeSchedule({ frequency: 'monthly', hour_utc: 8, day_of_month: 15 }),
    );

    const [, , opts] = mockAdd.mock.calls[0] as [string, unknown, { repeat: { pattern: string }; jobId: string }];
    expect(opts.repeat.pattern).toBe('0 8 15 * *');
  });

  it('uses deterministic jobId "report-schedule:{schedule.id}"', async () => {
    await registerSchedule(makeSchedule({ id: 'sched-abc' }));

    const [, , opts] = mockAdd.mock.calls[0] as [string, unknown, { jobId: string }];
    expect(opts.jobId).toBe('report-schedule:sched-abc');
  });
});

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

describe('reconcile', () => {
  it('does not call queue.add for a schedule already registered in BullMQ', async () => {
    const schedule = makeSchedule({ id: 'sched-existing' });
    mockFindAllActive.mockResolvedValueOnce([schedule]);
    mockGetRepeatableJobs.mockResolvedValueOnce([
      {
        id: 'report-schedule:sched-existing',
        key: 'key::report-schedule:sched-existing',
        name: 'generate-report',
        cron: '0 0 * * *',
        next: Date.now() + 86400000,
      },
    ]);

    await reconcile(fakeDb);

    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('calls queue.add for a schedule missing from BullMQ', async () => {
    const schedule = makeSchedule({ id: 'sched-missing' });
    mockFindAllActive.mockResolvedValueOnce([schedule]);
    mockGetRepeatableJobs.mockResolvedValueOnce([]);

    await reconcile(fakeDb);

    expect(mockAdd).toHaveBeenCalledTimes(1);
    const [, , opts] = mockAdd.mock.calls[0] as [string, unknown, { jobId: string }];
    expect(opts.jobId).toBe('report-schedule:sched-missing');
  });

  it('only re-registers schedules that are missing, not those already present', async () => {
    const existingSchedule = makeSchedule({ id: 'sched-present' });
    const missingSchedule = makeSchedule({ id: 'sched-absent' });
    mockFindAllActive.mockResolvedValueOnce([existingSchedule, missingSchedule]);
    mockGetRepeatableJobs.mockResolvedValueOnce([
      {
        id: 'report-schedule:sched-present',
        key: 'key::report-schedule:sched-present',
        name: 'generate-report',
        cron: '0 0 * * *',
        next: Date.now() + 86400000,
      },
    ]);

    await reconcile(fakeDb);

    expect(mockAdd).toHaveBeenCalledTimes(1);
    const [, , opts] = mockAdd.mock.calls[0] as [string, unknown, { jobId: string }];
    expect(opts.jobId).toBe('report-schedule:sched-absent');
  });

  it('does nothing when there are no active schedules', async () => {
    mockFindAllActive.mockResolvedValueOnce([]);

    await reconcile(fakeDb);

    expect(mockAdd).not.toHaveBeenCalled();
  });
});
