import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { Queue } from 'bullmq';
import type { StepJobData } from '../queue/step-queue.js';
import { assignVariant, type AbTestConfig } from './ab-assigner.js';
import type { SequenceDefinitionsRepository } from '../repositories/sequence-definitions.repo.js';
import type { SequenceVersionsRepository } from '../repositories/sequence-versions.repo.js';
import type { EnrollmentsRepository } from '../repositories/enrollments.repo.js';
import type { StepExecutionsRepository } from '../repositories/step-executions.repo.js';

export type EnrollInput = {
  sequence_id: string;
  entity_type: string;
  entity_id: string;
  context: Record<string, unknown>;
  dedup_key: string;
};

export type EnrollResult = {
  enrollment_id: string;
  already_enrolled: boolean;
};

type StepDef = {
  id: string;
  delay: { value: number; unit: 'minutes' | 'hours' | 'days' };
};

const UNIT_MS = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
} as const;

export class EnrollmentManager {
  constructor(
    private db: Knex,
    private definitionsRepo: SequenceDefinitionsRepository,
    private versionsRepo: SequenceVersionsRepository,
    private enrollmentsRepo: EnrollmentsRepository,
    private stepExecutionsRepo: StepExecutionsRepository,
    private queue: Queue<StepJobData> | null,
  ) {}

  async enroll(input: EnrollInput): Promise<EnrollResult> {
    // Step 1 — Dedup
    const existing = await this.enrollmentsRepo.findByDedupKey(input.dedup_key);
    if (existing) {
      return { enrollment_id: existing.id, already_enrolled: true };
    }

    // Step 2 — Load definition
    const definition = await this.definitionsRepo.findById(input.sequence_id);
    if (!definition) {
      throw Object.assign(new Error('sequence_not_found'), { code: 'sequence_not_found' });
    }

    // Step 3 — Validate status
    if (definition.status === 'disabled') {
      throw Object.assign(new Error('sequence_disabled'), { code: 'sequence_disabled' });
    }
    if (definition.status !== 'active' || definition.active_version === null) {
      throw Object.assign(new Error('sequence_not_active'), { code: 'sequence_not_active' });
    }

    // Step 4 — Load version
    const version = await this.versionsRepo.findBySequenceAndVersion(
      input.sequence_id,
      definition.active_version,
    );
    if (!version) {
      throw Object.assign(new Error('sequence_version_not_found'), {
        code: 'sequence_version_not_found',
      });
    }

    // Step 5 — Assign variant
    const ab_variant = assignVariant(version.ab_test as AbTestConfig | null);

    // Step 6 — Compute scheduled_at for each step
    const enrolledAt = new Date();
    const steps = version.steps as StepDef[];
    const scheduledAts = steps.map((step) => {
      const delayMs = step.delay.value * UNIT_MS[step.delay.unit];
      return new Date(enrolledAt.getTime() + delayMs);
    });

    // Step 7 — DB transaction
    const { enrollment, stepRows } = await this.db.transaction(async (trx) => {
      const enrollment = await this.enrollmentsRepo.insert(
        {
          sequence_id: input.sequence_id,
          sequence_version: definition.active_version!,
          entity_type: input.entity_type,
          entity_id: input.entity_id,
          context: input.context,
          ab_variant,
          status: 'active',
          enrolled_at: enrolledAt,
          dedup_key: input.dedup_key,
        },
        trx,
      );

      const insertData = steps.map((step, i) => ({
        enrollment_id: enrollment.id,
        step_id: step.id,
        step_index: i,
        scheduled_at: scheduledAts[i],
        job_id: null as null,
        status: 'pending' as const,
        attempt: 0 as const,
      }));

      const stepRows = await this.stepExecutionsRepo.insertMany(insertData, trx);
      return { enrollment, stepRows };
    });

    // Step 8 — Post-commit enqueue
    if (this.queue !== null) {
      const sortedStepRows = [...stepRows].sort((a, b) => a.step_index - b.step_index);
      for (const stepRow of sortedStepRows) {
        const job = await this.queue.add(
          'execute-step',
          {
            enrollment_id: enrollment.id,
            step_execution_id: stepRow.id,
            step_id: stepRow.step_id,
            step_index: stepRow.step_index,
          },
          {
            delay: Math.max(0, stepRow.scheduled_at.getTime() - Date.now()),
            jobId: randomUUID(),
          },
        );
        await this.stepExecutionsRepo.updateJobId(stepRow.id, job.id!);
      }
    }

    return { enrollment_id: enrollment.id, already_enrolled: false };
  }
}
