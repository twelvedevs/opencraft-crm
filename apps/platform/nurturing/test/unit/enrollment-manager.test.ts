import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnrollmentManager } from '../../src/services/enrollment-manager.js';

const mockEnrollment = {
  id: 'enrollment-uuid-1',
  sequence_id: 'seq-1',
  sequence_version: 1,
  entity_type: 'lead',
  entity_id: 'lead-1',
  context: {},
  ab_variant: null,
  status: 'active',
  enrolled_at: new Date(),
  completed_at: null,
  dedup_key: 'dedup-1',
};

const mockStepRows = [
  {
    id: 'step-exec-1',
    enrollment_id: 'enrollment-uuid-1',
    step_id: 'step-1',
    step_index: 0,
    scheduled_at: new Date(Date.now() + 86_400_000),
    job_id: null,
    status: 'pending',
    attempt: 0,
    output: null,
    error: null,
    started_at: null,
    completed_at: null,
  },
  {
    id: 'step-exec-2',
    enrollment_id: 'enrollment-uuid-1',
    step_id: 'step-2',
    step_index: 1,
    scheduled_at: new Date(Date.now() + 259_200_000),
    job_id: null,
    status: 'pending',
    attempt: 0,
    output: null,
    error: null,
    started_at: null,
    completed_at: null,
  },
];

const makeRepos = () => ({
  definitionsRepo: {
    findById: vi.fn(),
    create: vi.fn(),
    findAll: vi.fn(),
    updateCurrentVersion: vi.fn(),
    setActiveVersion: vi.fn(),
    updateStatus: vi.fn(),
  },
  versionsRepo: {
    findBySequenceAndVersion: vi.fn(),
    insert: vi.fn(),
    findLatestForSequence: vi.fn(),
  },
  enrollmentsRepo: {
    findByDedupKey: vi.fn(),
    insert: vi.fn(),
    findById: vi.fn(),
    findBySequenceId: vi.fn(),
    updateStatus: vi.fn(),
    findActiveByEntity: vi.fn(),
    findActiveByEntityAcrossAllSequences: vi.fn(),
  },
  stepExecutionsRepo: {
    insertMany: vi.fn(),
    updateJobId: vi.fn(),
    findByEnrollmentId: vi.fn(),
    findByEnrollmentAndStepId: vi.fn(),
    claimPending: vi.fn(),
    updateStatus: vi.fn(),
    updateScheduledAt: vi.fn(),
    cancelByEnrollment: vi.fn(),
    findPendingWithNullJobId: vi.fn(),
    findOrphanedOverdueSteps: vi.fn(),
  },
});

const makeDb = () => ({
  transaction: vi.fn().mockImplementation(async (cb: Function) => cb({})),
});

const makeQueue = () => ({
  add: vi.fn().mockResolvedValue({ id: 'mock-job-id' }),
});

const BASE_INPUT = {
  sequence_id: 'seq-1',
  entity_type: 'lead',
  entity_id: 'lead-1',
  context: {},
  dedup_key: 'dedup-1',
};

const ACTIVE_DEFINITION = {
  id: 'seq-1',
  name: 'Test Sequence',
  status: 'active',
  active_version: 1,
  current_version: 1,
  created_by: null,
  created_at: new Date(),
  updated_at: new Date(),
};

const ACTIVE_VERSION = {
  id: 'ver-1',
  sequence_id: 'seq-1',
  version: 1,
  active_hours: null,
  cancel_on_opt_out: false,
  steps: [
    { id: 'step-1', delay: { value: 24, unit: 'hours' } },
    { id: 'step-2', delay: { value: 72, unit: 'hours' } },
  ],
  ab_test: null,
  created_by: null,
  created_at: new Date(),
};

describe('EnrollmentManager', () => {
  let repos: ReturnType<typeof makeRepos>;
  let mockDb: ReturnType<typeof makeDb>;
  let mockQueue: ReturnType<typeof makeQueue>;

  beforeEach(() => {
    repos = makeRepos();
    mockDb = makeDb();
    mockQueue = makeQueue();
  });

  it('returns already_enrolled:true when dedup key exists', async () => {
    repos.enrollmentsRepo.findByDedupKey.mockResolvedValue(mockEnrollment);

    const manager = new EnrollmentManager(
      mockDb as any,
      repos.definitionsRepo as any,
      repos.versionsRepo as any,
      repos.enrollmentsRepo as any,
      repos.stepExecutionsRepo as any,
      mockQueue as any,
    );

    const result = await manager.enroll(BASE_INPUT);
    expect(result).toEqual({ enrollment_id: mockEnrollment.id, already_enrolled: true });
    expect(repos.definitionsRepo.findById).not.toHaveBeenCalled();
  });

  it('throws sequence_not_found when definition is null', async () => {
    repos.enrollmentsRepo.findByDedupKey.mockResolvedValue(null);
    repos.definitionsRepo.findById.mockResolvedValue(null);

    const manager = new EnrollmentManager(
      mockDb as any,
      repos.definitionsRepo as any,
      repos.versionsRepo as any,
      repos.enrollmentsRepo as any,
      repos.stepExecutionsRepo as any,
      null,
    );

    await expect(manager.enroll(BASE_INPUT)).rejects.toMatchObject({ code: 'sequence_not_found' });
  });

  it('throws sequence_disabled when definition.status is disabled', async () => {
    repos.enrollmentsRepo.findByDedupKey.mockResolvedValue(null);
    repos.definitionsRepo.findById.mockResolvedValue({ ...ACTIVE_DEFINITION, status: 'disabled' });

    const manager = new EnrollmentManager(
      mockDb as any,
      repos.definitionsRepo as any,
      repos.versionsRepo as any,
      repos.enrollmentsRepo as any,
      repos.stepExecutionsRepo as any,
      null,
    );

    await expect(manager.enroll(BASE_INPUT)).rejects.toMatchObject({ code: 'sequence_disabled' });
  });

  it('throws sequence_not_active when definition.status is draft (active_version null)', async () => {
    repos.enrollmentsRepo.findByDedupKey.mockResolvedValue(null);
    repos.definitionsRepo.findById.mockResolvedValue({
      ...ACTIVE_DEFINITION,
      status: 'draft',
      active_version: null,
    });

    const manager = new EnrollmentManager(
      mockDb as any,
      repos.definitionsRepo as any,
      repos.versionsRepo as any,
      repos.enrollmentsRepo as any,
      repos.stepExecutionsRepo as any,
      null,
    );

    await expect(manager.enroll(BASE_INPUT)).rejects.toMatchObject({ code: 'sequence_not_active' });
  });

  it('happy path: insertMany called with correct scheduled_at times', async () => {
    repos.enrollmentsRepo.findByDedupKey.mockResolvedValue(null);
    repos.definitionsRepo.findById.mockResolvedValue(ACTIVE_DEFINITION);
    repos.versionsRepo.findBySequenceAndVersion.mockResolvedValue(ACTIVE_VERSION);
    repos.enrollmentsRepo.insert.mockResolvedValue(mockEnrollment);
    repos.stepExecutionsRepo.insertMany.mockResolvedValue(mockStepRows);

    const manager = new EnrollmentManager(
      mockDb as any,
      repos.definitionsRepo as any,
      repos.versionsRepo as any,
      repos.enrollmentsRepo as any,
      repos.stepExecutionsRepo as any,
      mockQueue as any,
    );

    const before = Date.now();
    await manager.enroll(BASE_INPUT);

    const insertManyCall = repos.stepExecutionsRepo.insertMany.mock.calls[0][0];
    expect(insertManyCall).toHaveLength(2);

    const t0 = insertManyCall[0].scheduled_at.getTime();
    const t1 = insertManyCall[1].scheduled_at.getTime();

    // step 0: 24 hours = 86_400_000 ms after enrolledAt
    expect(t0 - (before + 86_400_000)).toBeLessThanOrEqual(100);
    // step 1: 72 hours = 259_200_000 ms after enrolledAt
    expect(t1 - (before + 259_200_000)).toBeLessThanOrEqual(100);
  });

  it('happy path: queue.add called twice and updateJobId called twice', async () => {
    repos.enrollmentsRepo.findByDedupKey.mockResolvedValue(null);
    repos.definitionsRepo.findById.mockResolvedValue(ACTIVE_DEFINITION);
    repos.versionsRepo.findBySequenceAndVersion.mockResolvedValue(ACTIVE_VERSION);
    repos.enrollmentsRepo.insert.mockResolvedValue(mockEnrollment);
    repos.stepExecutionsRepo.insertMany.mockResolvedValue(mockStepRows);

    const manager = new EnrollmentManager(
      mockDb as any,
      repos.definitionsRepo as any,
      repos.versionsRepo as any,
      repos.enrollmentsRepo as any,
      repos.stepExecutionsRepo as any,
      mockQueue as any,
    );

    await manager.enroll(BASE_INPUT);

    expect(mockQueue.add).toHaveBeenCalledTimes(2);
    expect(repos.stepExecutionsRepo.updateJobId).toHaveBeenCalledTimes(2);
  });

  it('queue is null: enrollment still inserted; queue.add not called', async () => {
    repos.enrollmentsRepo.findByDedupKey.mockResolvedValue(null);
    repos.definitionsRepo.findById.mockResolvedValue(ACTIVE_DEFINITION);
    repos.versionsRepo.findBySequenceAndVersion.mockResolvedValue(ACTIVE_VERSION);
    repos.enrollmentsRepo.insert.mockResolvedValue(mockEnrollment);
    repos.stepExecutionsRepo.insertMany.mockResolvedValue(mockStepRows);

    const manager = new EnrollmentManager(
      mockDb as any,
      repos.definitionsRepo as any,
      repos.versionsRepo as any,
      repos.enrollmentsRepo as any,
      repos.stepExecutionsRepo as any,
      null,
    );

    const result = await manager.enroll(BASE_INPUT);
    expect(result).toEqual({ enrollment_id: mockEnrollment.id, already_enrolled: false });
    expect(repos.enrollmentsRepo.insert).toHaveBeenCalledOnce();
    // queue.add was never called (queue is null)
    expect(repos.stepExecutionsRepo.updateJobId).not.toHaveBeenCalled();
  });
});
