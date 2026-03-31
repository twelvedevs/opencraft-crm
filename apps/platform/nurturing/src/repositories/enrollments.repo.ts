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
    trx?: Knex.Transaction,
  ): Promise<SequenceEnrollment | null> {
    const qb = trx ?? this.db;
    const row = await qb(ENROLLMENTS_TABLE)
      .where({
        sequence_id: sequenceId,
        entity_type: entityType,
        entity_id: entityId,
        status: 'active',
      })
      .limit(1)
      .first();
    return (row as SequenceEnrollment) ?? null;
  }

  async findAllActiveByEntityId(entityId: string): Promise<SequenceEnrollment[]> {
    return this.db(ENROLLMENTS_TABLE).where({
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

  async markUnenrolled(id: string, trx?: Knex.Transaction): Promise<void> {
    const qb = trx ?? this.db;
    await qb(ENROLLMENTS_TABLE)
      .where({ id })
      .update({ status: 'unenrolled', updated_at: qb.fn.now() });
  }

  async findActiveWithAbTestEnabledByEntityId(
    entityId: string,
  ): Promise<Array<SequenceEnrollment & { ab_test: unknown }>> {
    const VERSIONS_TABLE = `${SCHEMA}.sequence_versions`;
    const rows = await this.db(`${ENROLLMENTS_TABLE} as se`)
      .join(`${VERSIONS_TABLE} as sv`, function () {
        this.on('sv.sequence_id', '=', 'se.sequence_id').andOn(
          'sv.version',
          '=',
          'se.sequence_version',
        );
      })
      .where('se.entity_id', entityId)
      .where('se.status', 'active')
      .whereNotNull('sv.ab_test')
      .whereRaw("sv.ab_test->>'enabled' = 'true'")
      .select('se.*', 'sv.ab_test as ab_test');
    return rows as Array<SequenceEnrollment & { ab_test: unknown }>;
  }

  async getEnrollmentCounts(sequenceId: string): Promise<{
    total: number;
    completed: number;
    unenrolled: number;
    failed: number;
    active: number;
  }> {
    const [row] = await this.db.raw<{ rows: Array<Record<string, string>> }>(
      `SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'unenrolled') AS unenrolled,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        COUNT(*) FILTER (WHERE status = 'active') AS active
      FROM ${ENROLLMENTS_TABLE}
      WHERE sequence_id = ?`,
      [sequenceId],
    ).then((r) => r.rows);
    return {
      total: parseInt(row['total'], 10),
      completed: parseInt(row['completed'], 10),
      unenrolled: parseInt(row['unenrolled'], 10),
      failed: parseInt(row['failed'], 10),
      active: parseInt(row['active'], 10),
    };
  }

  async getAbBreakdown(sequenceId: string): Promise<
    Array<{
      ab_variant: string;
      enrollments: number;
      completions: number;
      conversions: number;
    }>
  > {
    const CONVERSIONS_TABLE = `${SCHEMA}.sequence_conversions`;
    const rows = await this.db.raw<{ rows: Array<Record<string, string>> }>(
      `SELECT
        se.ab_variant,
        COUNT(*) AS enrollments,
        COUNT(*) FILTER (WHERE se.status = 'completed') AS completions,
        COUNT(sc.id) AS conversions
      FROM ${ENROLLMENTS_TABLE} se
      LEFT JOIN ${CONVERSIONS_TABLE} sc ON sc.enrollment_id = se.id
      WHERE se.sequence_id = ?
        AND se.ab_variant IS NOT NULL
      GROUP BY se.ab_variant`,
      [sequenceId],
    ).then((r) => r.rows);
    return rows.map((row) => ({
      ab_variant: row['ab_variant'],
      enrollments: parseInt(row['enrollments'], 10),
      completions: parseInt(row['completions'], 10),
      conversions: parseInt(row['conversions'], 10),
    }));
  }
}
