import { randomUUID } from 'node:crypto';
import { Worker, Queue, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { Knex } from 'knex';
import { interpolateFields, computeNextActiveWindowMs, type ActiveHoursConfig } from '@ortho/interpolator';
import { executeAction, type ExecutionContext, type ActionExecutorDeps, type StepDef } from './action-executor.js';
import type { StepJobData } from '../queue/step-queue.js';
import type { NurturingPublisher } from '../events/publisher.js';
import type { EnrollmentsRepository } from '../repositories/enrollments.repo.js';
import type { SequenceVersionsRepository } from '../repositories/sequence-versions.repo.js';
import type { StepExecutionsRepository } from '../repositories/step-executions.repo.js';

export interface StepWorkerDeps {
  db: Knex;
  enrollmentsRepo: EnrollmentsRepository;
  versionsRepo: SequenceVersionsRepository;
  stepExecutionsRepo: StepExecutionsRepository;
  queue: Queue<StepJobData>;
  publisher: NurturingPublisher;
  actionExecutorDeps: ActionExecutorDeps;
}

type StoredActiveHours = ActiveHoursConfig & { timezone_field: string };

export function createStepWorker(redisUrl: string, deps: StepWorkerDeps): Worker<StepJobData> {
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  const worker = new Worker<StepJobData>(
    'nurturing:step-execution',
    async (job: Job<StepJobData>): Promise<void> => {
      // Step 1 — Load enrollment
      const enrollment = await deps.enrollmentsRepo.findById(job.data.enrollment_id);
      if (enrollment === null || enrollment.status !== 'active') {
        await deps.stepExecutionsRepo.markCancelled(job.data.step_execution_id);
        return;
      }

      // Step 2 — Optimistic lock
      const claimed = await deps.stepExecutionsRepo.claimForExecution(job.data.step_execution_id);
      if (claimed === false) {
        return;
      }

      // Step 3 — Load step definition
      const version = await deps.versionsRepo.findBySequenceAndVersion(
        enrollment.sequence_id,
        enrollment.sequence_version,
      );
      if (!version) {
        throw new Error('step_definition_not_found');
      }
      const steps = version.steps as StepDef[];
      const stepDef = steps.find((s) => s.id === job.data.step_id);
      if (!stepDef) {
        throw new Error('step_definition_not_found');
      }

      // Step 4 — Build execution context
      const execCtx: ExecutionContext = {
        enrollment_id: enrollment.id,
        step_id: stepDef.id,
        entity_type: enrollment.entity_type,
        entity_id: enrollment.entity_id,
        enrollmentContext: enrollment.context as Record<string, unknown>,
        abVariant: enrollment.ab_variant,
      };

      // Step 5 — Active hours check (send_message and send_email only)
      if (
        version.active_hours !== null &&
        (stepDef.action.type === 'send_message' || stepDef.action.type === 'send_email')
      ) {
        const activeHours = version.active_hours as StoredActiveHours;
        const resolved = interpolateFields({ tz: activeHours.timezone_field }, { context: enrollment.context });
        const timezone = resolved['tz'] as string;
        const delayMs = computeNextActiveWindowMs(activeHours, timezone);
        if (delayMs > 0) {
          const newScheduledAt = new Date(Date.now() + delayMs);
          await deps.stepExecutionsRepo.updateDeferral(job.data.step_execution_id, newScheduledAt);
          const newJob = await deps.queue.add('execute-step', job.data, {
            delay: delayMs,
            jobId: randomUUID(),
          });
          await deps.stepExecutionsRepo.updateJobId(job.data.step_execution_id, newJob.id!);
          return;
        }
      }

      try {
        // Step 6 — Execute action
        const result = await executeAction(stepDef, execCtx, deps.actionExecutorDeps);

        // Step 6a — Chain send_message if call_ai returned chainSendMessage
        if (result.chainSendMessage !== undefined) {
          await fetch(`${deps.actionExecutorDeps.urls.messagingServiceUrl}/messages/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              body: result.chainSendMessage.body,
              to: result.chainSendMessage.to,
              from: result.chainSendMessage.from,
              dedup_key: result.chainSendMessage.dedup_key,
            }),
          });
        }

        // Step 7 — Mark step completed
        await deps.stepExecutionsRepo.markCompleted(job.data.step_execution_id, result.output ?? null);

        // Step 8 — Publish step_output_ready if applicable
        if (stepDef.action.type === 'call_ai' && stepDef.action.params['auto_send'] !== true) {
          await deps.publisher.publishStepOutputReady({
            enrollment_id: enrollment.id,
            step_id: stepDef.id,
            entity_type: enrollment.entity_type,
            entity_id: enrollment.entity_id,
          });
        }

        // Step 9 — Check if last step
        const allSteps = await deps.stepExecutionsRepo.findByEnrollmentId(enrollment.id);
        if (allSteps.every((s) => s.status === 'completed')) {
          await deps.enrollmentsRepo.updateStatus(enrollment.id, 'completed', {
            completedAt: new Date(),
          });
          await deps.publisher.publishEnrollmentCompleted({
            enrollment_id: enrollment.id,
            sequence_id: enrollment.sequence_id,
            entity_type: enrollment.entity_type,
            entity_id: enrollment.entity_id,
            completed_at: new Date().toISOString(),
          });
        }
      } catch (err) {
        await deps.stepExecutionsRepo.incrementAttempt(job.data.step_execution_id);
        if (job.attemptsMade >= 4) {
          await deps.stepExecutionsRepo.markFailed(job.data.step_execution_id, String(err));
          await deps.enrollmentsRepo.updateStatus(enrollment.id, 'failed');
          await deps.publisher.publishStepFailed({
            enrollment_id: enrollment.id,
            step_id: job.data.step_id,
            entity_type: enrollment.entity_type,
            entity_id: enrollment.entity_id,
            error: String(err),
            attempt: job.attemptsMade + 1,
          });
        }
        throw err;
      }
    },
    { connection },
  );

  return worker;
}
