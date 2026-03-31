import type { Knex } from 'knex';
import { Queue } from 'bullmq';
import type { EnrollmentsRepository } from '../repositories/enrollments.repo.js';
import type { StepExecutionsRepository } from '../repositories/step-executions.repo.js';
import type { NurturingPublisher } from '../events/publisher.js';
import type { StepJobData } from '../queue/step-queue.js';

export interface UnenrollParams {
  sequence_id: string;
  entity_type: string;
  entity_id: string;
}

export interface UnenrollmentDeps {
  db: Knex;
  enrollmentsRepo: EnrollmentsRepository;
  stepExecutionsRepo: StepExecutionsRepository;
  stepQueue: Queue<StepJobData>;
  publisher: NurturingPublisher;
}

export interface UnenrollResult {
  found: boolean;
  enrollment_id?: string;
}

export async function unenroll(params: UnenrollParams, deps: UnenrollmentDeps): Promise<UnenrollResult> {
  // Step 1 — Guard: find active enrollment; return idempotent no-op if not found
  const enrollment = await deps.enrollmentsRepo.findActiveByEntity(
    params.sequence_id,
    params.entity_type,
    params.entity_id,
  );
  if (!enrollment) return { found: false };

  // Step 2 — Atomic transaction: mark enrollment unenrolled + cancel pending steps
  const jobIds = await deps.db.transaction(async (trx) => {
    await deps.enrollmentsRepo.markUnenrolled(enrollment.id, trx);
    return deps.stepExecutionsRepo.cancelPendingByEnrollment(enrollment.id, trx);
  });

  // Step 3 — Best-effort BullMQ job removal
  for (const jobId of jobIds) {
    try {
      const job = await deps.stepQueue.getJob(jobId);
      await job?.remove();
    } catch (_err) {
      // log warning, do not throw
    }
  }

  // Step 4 — Publish event (after transaction commits)
  await deps.publisher.publishEnrollmentUnenrolled({
    enrollment_id: enrollment.id,
    sequence_id: enrollment.sequence_id,
    entity_type: enrollment.entity_type,
    entity_id: enrollment.entity_id,
  });

  // Step 5 — Return
  return { found: true, enrollment_id: enrollment.id };
}
