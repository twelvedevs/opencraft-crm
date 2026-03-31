import type { Knex } from 'knex';

export interface SequenceDefinition {
  id: string;
  name: string;
  status: string;
  active_version: number | null;
  current_version: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const SCHEMA = 'platform_nurturing';
const DEFINITIONS_TABLE = `${SCHEMA}.sequence_definitions`;

export class SequenceDefinitionsRepository {
  constructor(private readonly db: Knex) {}

  async create(data: { name: string; created_by?: string }): Promise<SequenceDefinition> {
    const [row] = await this.db(DEFINITIONS_TABLE)
      .insert({
        name: data.name,
        status: 'draft',
        current_version: 1,
        created_by: data.created_by ?? null,
      })
      .returning('*');
    return row as SequenceDefinition;
  }

  async findAll(opts: { limit: number; cursor?: string }): Promise<SequenceDefinition[]> {
    const query = this.db(DEFINITIONS_TABLE).orderBy('created_at', 'desc').limit(opts.limit);
    if (opts.cursor) {
      query.where('created_at', '<', opts.cursor);
    }
    return query as Promise<SequenceDefinition[]>;
  }

  async findById(id: string): Promise<SequenceDefinition | null> {
    const row = await this.db(DEFINITIONS_TABLE).where({ id }).first();
    return (row as SequenceDefinition) ?? null;
  }

  async updateCurrentVersion(id: string, version: number): Promise<SequenceDefinition | null> {
    const [row] = await this.db(DEFINITIONS_TABLE)
      .where({ id })
      .update({ current_version: version, updated_at: this.db.fn.now() })
      .returning('*');
    return (row as SequenceDefinition) ?? null;
  }

  async setActiveVersion(id: string, version: number): Promise<SequenceDefinition | null> {
    const [row] = await this.db(DEFINITIONS_TABLE)
      .where({ id })
      .update({ active_version: version, status: 'active', updated_at: this.db.fn.now() })
      .returning('*');
    return (row as SequenceDefinition) ?? null;
  }

  async updateStatus(id: string, status: string): Promise<SequenceDefinition | null> {
    const [row] = await this.db(DEFINITIONS_TABLE)
      .where({ id })
      .update({ status, updated_at: this.db.fn.now() })
      .returning('*');
    return (row as SequenceDefinition) ?? null;
  }
}
