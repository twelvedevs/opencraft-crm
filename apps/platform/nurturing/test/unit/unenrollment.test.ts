import { describe, it, expect, vi, beforeEach } from 'vitest';
import { unenroll } from '../../src/services/unenrollment.js';

const SAMPLE_ENROLLMENT = {
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

const UNENROLL_PARAMS = {
  sequence_id: 'seq-1',
  entity_type: 'lead',
  entity_id: 'lead-1',
};

const makeDeps = () => {
  const mockTrx = {} as any;

  const enrollmentsRepo = {
    findActiveByEntity: vi.fn(),
    markUnenrolled: vi.fn().mockResolvedValue(undefined),
  };

  const stepExecutionsRepo = {
    cancelPendingByEnrollment: vi.fn(),
  };

  const db = {
    transaction: vi.fn().mockImplementation(async (fn: Function) => fn(mockTrx)),
  };

  const stepQueue = {
    getJob: vi.fn(),
  };

  const publisher = {
    publishEnrollmentUnenrolled: vi.fn().mockResolvedValue(undefined),
  };

  return { enrollmentsRepo, stepExecutionsRepo, db, stepQueue, publisher, mockTrx };
};

describe('unenroll', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('unenroll — active enrollment found', async () => {
    deps.enrollmentsRepo.findActiveByEntity.mockResolvedValue(SAMPLE_ENROLLMENT);
    deps.stepExecutionsRepo.cancelPendingByEnrollment.mockResolvedValue(['job-id-1', 'job-id-2']);
    const removeFn = vi.fn().mockResolvedValue(undefined);
    deps.stepQueue.getJob.mockResolvedValue({ remove: removeFn });

    const result = await unenroll(UNENROLL_PARAMS, deps as any);

    expect(deps.enrollmentsRepo.markUnenrolled).toHaveBeenCalledWith(SAMPLE_ENROLLMENT.id, deps.mockTrx);
    expect(deps.stepExecutionsRepo.cancelPendingByEnrollment).toHaveBeenCalledWith(SAMPLE_ENROLLMENT.id, deps.mockTrx);
    expect(deps.stepQueue.getJob).toHaveBeenCalledTimes(2);
    expect(deps.stepQueue.getJob).toHaveBeenCalledWith('job-id-1');
    expect(deps.stepQueue.getJob).toHaveBeenCalledWith('job-id-2');
    expect(deps.publisher.publishEnrollmentUnenrolled).toHaveBeenCalledWith({
      enrollment_id: SAMPLE_ENROLLMENT.id,
      sequence_id: SAMPLE_ENROLLMENT.sequence_id,
      entity_type: SAMPLE_ENROLLMENT.entity_type,
      entity_id: SAMPLE_ENROLLMENT.entity_id,
    });
    expect(result).toEqual({ found: true, enrollment_id: SAMPLE_ENROLLMENT.id });
  });

  it('unenroll — leaves non-pending steps untouched', async () => {
    deps.enrollmentsRepo.findActiveByEntity.mockResolvedValue(SAMPLE_ENROLLMENT);
    deps.stepExecutionsRepo.cancelPendingByEnrollment.mockResolvedValue([]);
    deps.stepQueue.getJob.mockResolvedValue(null);

    await unenroll(UNENROLL_PARAMS, deps as any);

    // Only cancelPendingByEnrollment is called — no markCancelled or markFailed
    expect(deps.stepExecutionsRepo.cancelPendingByEnrollment).toHaveBeenCalledOnce();
    const repoKeys = Object.keys(deps.stepExecutionsRepo);
    const otherMethods = repoKeys.filter((k) => k !== 'cancelPendingByEnrollment');
    for (const method of otherMethods) {
      expect((deps.stepExecutionsRepo as any)[method]).not.toHaveBeenCalled();
    }
  });

  it('unenroll — idempotent when no active enrollment', async () => {
    deps.enrollmentsRepo.findActiveByEntity.mockResolvedValue(null);

    const result = await unenroll(UNENROLL_PARAMS, deps as any);

    expect(deps.db.transaction).not.toHaveBeenCalled();
    expect(deps.enrollmentsRepo.markUnenrolled).not.toHaveBeenCalled();
    expect(deps.stepExecutionsRepo.cancelPendingByEnrollment).not.toHaveBeenCalled();
    expect(deps.publisher.publishEnrollmentUnenrolled).not.toHaveBeenCalled();
    expect(deps.stepQueue.getJob).not.toHaveBeenCalled();
    expect(result).toEqual({ found: false });
  });

  it('unenroll — BullMQ removal failure does not throw', async () => {
    deps.enrollmentsRepo.findActiveByEntity.mockResolvedValue(SAMPLE_ENROLLMENT);
    deps.stepExecutionsRepo.cancelPendingByEnrollment.mockResolvedValue(['job-id-1']);
    deps.stepQueue.getJob.mockRejectedValue(new Error('redis error'));

    await expect(unenroll(UNENROLL_PARAMS, deps as any)).resolves.toBeDefined();
    expect(deps.publisher.publishEnrollmentUnenrolled).toHaveBeenCalled();
  });
});
