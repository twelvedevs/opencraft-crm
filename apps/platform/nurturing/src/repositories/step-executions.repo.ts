import type { Knex } from 'knex';

export interface SequenceStepExecution {
  id: string;
  enrollment_id: string;
  step_id: string;
  step_index: number;
  scheduled_at: Date;
  job_id: string | null;
  status: string;
  attempt: number;
  output: unknown | null;
  error: string | null;
  started_at: Date | null;
  completed_at: Date | null;
}

export interface InsertStepExecutionData {
  enrollment_id: string;
  step_id: string;
  step_index: number;
  scheduled_at: Date;
  job_id: null;
  status: 'pending';
  attempt: 0;
}

const SCHEMA = 'platform_nurturing';
const STEPS_TABLE = `${SCHEMA}.sequence_step_executions`;

export class StepExecutionsRepository {
  constructor(private readonly db: Knex) {}

  async insertMany(rows: InsertStepExecutionData[], trx?: Knex.Transaction): Promise<SequenceStepExecution[]> {
    if (rows.length === 0) return [];
    const qb = trx ?? this.db;
    const inserts = rows.map((r) => ({
      enrollment_id: r.enrollment_id,
      step_id: r.step_id,
      step_index: r.step_index,
      scheduled_at: r.scheduled_at,
      job_id: r.job_id,
      status: r.status,
      attempt: r.attempt,
    }));
    return qb(STEPS_TABLE).insert(inserts).returning('*') as Promise<SequenceStepExecution[]>;
  }

  async updateJobId(id: string, jobId: string): Promise<void> {
    await this.db(STEPS_TABLE).where({ id }).update({ job_id: jobId });
  }

  async findByEnrollmentId(enrollmentId: string): Promise<SequenceStepExecution[]> {
    return this.db(STEPS_TABLE)
      .where({ enrollment_id: enrollmentId })
      .orderBy('step_index', 'asc') as Promise<SequenceStepExecution[]>;
  }

  async findByEnrollmentAndStepId(
    enrollmentId: string,
    stepId: string,
  ): Promise<SequenceStepExecution | null> {
    const row = await this.db(STEPS_TABLE)
      .where({ enrollment_id: enrollmentId, step_id: stepId })
      .first();
    return (row as SequenceStepExecution) ?? null;
  }

  async claimPending(id: string): Promise<string | null> {
    const rows = await this.db(STEPS_TABLE)
      .where({ id, status: 'pending' })
      .update({ status: 'running', started_at: this.db.fn.now() })
      .returning('id');
    if (rows.length === 0) return null;
    return (rows[0] as { id: string }).id;
  }

  async updateStatus(
    id: string,
    status: string,
    opts?: {
      output?: unknown;
      error?: string;
      startedAt?: Date;
      completedAt?: Date;
    },
  ): Promise<void> {
    const updates: Record<string, unknown> = { status };
    if (opts?.output !== undefined) updates['output'] = opts.output;
    if (opts?.error !== undefined) updates['error'] = opts.error;
    if (opts?.startedAt !== undefined) updates['started_at'] = opts.startedAt;
    if (opts?.completedAt !== undefined) updates['completed_at'] = opts.completedAt;
    await this.db(STEPS_TABLE).where({ id }).update(updates);
  }

  async updateScheduledAt(id: string, scheduledAt: Date, jobId: string | null): Promise<void> {
    await this.db(STEPS_TABLE).where({ id }).update({
      scheduled_at: scheduledAt,
      job_id: jobId,
      status: 'pending',
    });
  }

  async cancelByEnrollment(enrollmentId: string, trx?: Knex.Transaction): Promise<void> {
    const qb = trx ?? this.db;
    await qb(STEPS_TABLE)
      .where({ enrollment_id: enrollmentId, status: 'pending' })
      .update({ status: 'cancelled' });
  }

  async findPendingWithNullJobId(): Promise<SequenceStepExecution[]> {
    return this.db(STEPS_TABLE)
      .where({ status: 'pending' })
      .whereNull('job_id') as Promise<SequenceStepExecution[]>;
  }

  async findOrphanedOverdueSteps(): Promise<SequenceStepExecution[]> {
    return this.db(STEPS_TABLE)
      .where({ status: 'pending' })
      .whereNotNull('job_id')
      .where('scheduled_at', '<', this.db.raw("now() - interval '1 minute'")) as Promise<SequenceStepExecution[]>;
  }

  async findById(id: string): Promise<SequenceStepExecution | null> {
    const row = await this.db(STEPS_TABLE).where({ id }).first();
    return (row as SequenceStepExecution) ?? null;
  }

  async claimForExecution(id: string): Promise<boolean> {
    const rows = await this.db(STEPS_TABLE)
      .where({ id })
      .where('status', 'pending')
      .update({ status: 'running', started_at: this.db.fn.now() })
      .returning('id');
    return rows.length > 0;
  }

  async markCompleted(id: string, output: unknown | null): Promise<void> {
    await this.db(STEPS_TABLE).where({ id }).update({
      status: 'completed',
      completed_at: this.db.fn.now(),
      output: output !== null ? JSON.stringify(output) : null,
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db(STEPS_TABLE).where({ id }).update({
      status: 'failed',
      error,
      completed_at: this.db.fn.now(),
    });
  }

  async markCancelled(id: string): Promise<void> {
    await this.db(STEPS_TABLE)
      .where({ id })
      .where('status', 'pending')
      .update({ status: 'cancelled' });
  }

  async updateDeferral(id: string, scheduledAt: Date): Promise<void> {
    await this.db(STEPS_TABLE).where({ id }).update({
      scheduled_at: scheduledAt,
      status: 'pending',
      job_id: null,
    });
  }

  async incrementAttempt(id: string): Promise<void> {
    await this.db(STEPS_TABLE).where({ id }).update({
      attempt: this.db.raw('attempt + 1'),
    });
  }
}
