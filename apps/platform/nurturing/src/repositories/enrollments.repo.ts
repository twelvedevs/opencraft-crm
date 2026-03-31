import type { Knex } from 'knex';

export interface SequenceEnrollment {
  id: string;
  sequence_id: string;
  sequence_version: number;
  entity_type: string;
  entity_id: string;
  context: Record<string, unknown>;
  ab_variant: string | null;
  status: string;
  enrolled_at: Date;
  completed_at: Date | null;
  dedup_key: string;
}

export interface InsertEnrollmentData {
  sequence_id: string;
  sequence_version: number;
  entity_type: string;
  entity_id: string;
  context: Record<string, unknown>;
  ab_variant: string | null;
  status: string;
  enrolled_at: Date;
  dedup_key: string;
}

const SCHEMA = 'platform_nurturing';
const ENROLLMENTS_TABLE = `${SCHEMA}.sequence_enrollments`;

export class EnrollmentsRepository {
  constructor(private readonly db: Knex) {}

  async findByDedupKey(dedupKey: string): Promise<SequenceEnrollment | null> {
    const row = await this.db(ENROLLMENTS_TABLE).where({ dedup_key: dedupKey }).first();
    return (row as SequenceEnrollment) ?? null;
  }

  async insert(data: InsertEnrollmentData, trx?: Knex.Transaction): Promise<SequenceEnrollment> {
    const qb = trx ?? this.db;
    const [row] = await qb(ENROLLMENTS_TABLE)
      .insert({
        sequence_id: data.sequence_id,
        sequence_version: data.sequence_version,
        entity_type: data.entity_type,
        entity_id: data.entity_id,
        context: JSON.stringify(data.context),
        ab_variant: data.ab_variant,
        status: data.status,
        enrolled_at: data.enrolled_at,
        dedup_key: data.dedup_key,
      })
      .returning('*');
    return row as SequenceEnrollment;
  }

  async findById(id: string): Promise<SequenceEnrollment | null> {
    const row = await this.db(ENROLLMENTS_TABLE).where({ id }).first();
    return (row as SequenceEnrollment) ?? null;
  }

  async findBySequenceId(
    sequenceId: string,
    opts: { limit: number; cursor?: string },
  ): Promise<SequenceEnrollment[]> {
    const query = this.db(ENROLLMENTS_TABLE)
      .where({ sequence_id: sequenceId })
      .orderBy('enrolled_at', 'desc')
      .limit(opts.limit);
    if (opts.cursor) {
      query.where('enrolled_at', '<', new Date(opts.cursor));
    }
    return query as Promise<SequenceEnrollment[]>;
  }

  async updateStatus(
    id: string,
    status: 'completed' | 'failed',
    opts?: { completedAt?: Date },
  ): Promise<void> {
    const updates: Record<string, unknown> = { status };
    if (opts?.completedAt !== undefined) {
      updates['completed_at'] = opts.completedAt;
    }
    await this.db(ENROLLMENTS_TABLE).where({ id }).update(updates);
  }

  async findActiveByEntity(
    sequenceId: string,
    entityType: string,
    entityId: string,
  ): Promise<SequenceEnrollment[]> {
    return this.db(ENROLLMENTS_TABLE).where({
      sequence_id: sequenceId,
      entity_type: entityType,
      entity_id: entityId,
      status: 'active',
    }) as Promise<SequenceEnrollment[]>;
  }

  async findActiveByEntityAcrossAllSequences(
    entityType: string,
    entityId: string,
  ): Promise<SequenceEnrollment[]> {
    return this.db(ENROLLMENTS_TABLE).where({
      entity_type: entityType,
      entity_id: entityId,
      status: 'active',
    }) as Promise<SequenceEnrollment[]>;
  }
}
