import type { Knex } from '../db.js';

export interface AudienceSegment {
  id: string;
  name: string;
  status: string;
  active_version: number | null;
  current_version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AudienceSegmentVersion {
  id: string;
  segment_id: string;
  version: number;
  filter: unknown;
  created_by: string | null;
  created_at: string;
}

export class SegmentsRepository {
  private db: Knex;

  constructor(db: Knex) {
    this.db = db;
  }

  async create(data: {
    id: string;
    name: string;
    created_by?: string | null;
  }): Promise<AudienceSegment> {
    const [row] = await this.db('audience_segments')
      .insert({
        id: data.id,
        name: data.name,
        created_by: data.created_by ?? null,
      })
      .returning('*');
    return row as AudienceSegment;
  }

  async createVersion(data: {
    id: string;
    segment_id: string;
    version: number;
    filter: unknown;
    created_by?: string | null;
  }): Promise<void> {
    await this.db('audience_segment_versions').insert({
      id: data.id,
      segment_id: data.segment_id,
      version: data.version,
      filter: JSON.stringify(data.filter),
      created_by: data.created_by ?? null,
    });
  }

  async findById(id: string): Promise<AudienceSegment | null> {
    const row = await this.db('audience_segments').where({ id }).first();
    return (row as AudienceSegment) ?? null;
  }

  async findVersionRow(
    segmentId: string,
    version: number,
  ): Promise<AudienceSegmentVersion | null> {
    const row = await this.db('audience_segment_versions')
      .where({ segment_id: segmentId, version })
      .first();
    return (row as AudienceSegmentVersion) ?? null;
  }

  async updateCurrentVersionFilter(
    segmentId: string,
    version: number,
    filter: unknown,
  ): Promise<void> {
    await this.db('audience_segment_versions')
      .where({ segment_id: segmentId, version })
      .update({ filter: JSON.stringify(filter) });
  }

  async incrementVersion(segmentId: string): Promise<number> {
    const [row] = await this.db('audience_segments')
      .where({ id: segmentId })
      .update({
        current_version: this.db.raw('current_version + 1'),
        updated_at: this.db.fn.now(),
      })
      .returning('current_version');
    return (row as { current_version: number }).current_version;
  }

  async updateStatus(
    segmentId: string,
    status: string,
    activeVersion?: number,
  ): Promise<AudienceSegment | null> {
    const update: Record<string, unknown> = {
      status,
      updated_at: this.db.fn.now(),
    };
    if (activeVersion !== undefined) {
      update.active_version = activeVersion;
    }
    const [row] = await this.db('audience_segments')
      .where({ id: segmentId })
      .update(update)
      .returning('*');
    return (row as AudienceSegment) ?? null;
  }

  async list(
    filters: { status?: string[] },
    pagination: { limit: number; offset: number },
  ): Promise<{ items: AudienceSegment[]; total: number }> {
    let query = this.db('audience_segments');
    let countQuery = this.db('audience_segments');

    if (filters.status && filters.status.length > 0) {
      query = query.whereIn('status', filters.status);
      countQuery = countQuery.whereIn('status', filters.status);
    }

    const [{ count }] = await countQuery.count('* as count');
    const items = await query
      .orderBy('created_at', 'desc')
      .limit(pagination.limit)
      .offset(pagination.offset);

    return {
      items: items as AudienceSegment[],
      total: Number(count),
    };
  }
}
