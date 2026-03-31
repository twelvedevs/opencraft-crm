import type { Knex } from 'knex';

export interface SequenceVersion {
  id: string;
  sequence_id: string;
  version: number;
  active_hours: unknown | null;
  cancel_on_opt_out: boolean;
  steps: unknown;
  ab_test: unknown | null;
  created_by: string | null;
  created_at: Date;
}

export interface CreateVersionInput {
  sequence_id: string;
  version: number;
  active_hours?: unknown;
  cancel_on_opt_out?: boolean;
  steps: unknown;
  ab_test?: unknown;
  created_by?: string;
}

const SCHEMA = 'platform_nurturing';
const VERSIONS_TABLE = `${SCHEMA}.sequence_versions`;

export class SequenceVersionsRepository {
  constructor(private readonly db: Knex) {}

  async insert(data: CreateVersionInput): Promise<SequenceVersion> {
    const [row] = await this.db(VERSIONS_TABLE)
      .insert({
        sequence_id: data.sequence_id,
        version: data.version,
        active_hours: data.active_hours !== undefined ? JSON.stringify(data.active_hours) : null,
        cancel_on_opt_out: data.cancel_on_opt_out ?? false,
        steps: JSON.stringify(data.steps),
        ab_test: data.ab_test !== undefined ? JSON.stringify(data.ab_test) : null,
        created_by: data.created_by ?? null,
      })
      .returning('*');
    return row as SequenceVersion;
  }

  async findBySequenceAndVersion(sequenceId: string, version: number): Promise<SequenceVersion | null> {
    const row = await this.db(VERSIONS_TABLE)
      .where({ sequence_id: sequenceId, version })
      .first();
    return (row as SequenceVersion) ?? null;
  }

  async findLatestForSequence(sequenceId: string): Promise<SequenceVersion | null> {
    const row = await this.db(VERSIONS_TABLE)
      .where({ sequence_id: sequenceId })
      .orderBy('version', 'desc')
      .first();
    return (row as SequenceVersion) ?? null;
  }
}
