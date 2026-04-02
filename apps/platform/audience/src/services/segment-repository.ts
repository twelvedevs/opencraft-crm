import type { Knex } from '../db.js';

export interface SegmentWithFilter {
  id: string;
  name: string;
  status: string;
  active_version: number | null;
  current_version: number;
  filter: unknown | null;
}

const TTL_MS = 30_000;

export class SegmentRepository {
  private db: Knex;
  private cache: Map<string, { value: SegmentWithFilter; expiresAt: number }> = new Map();

  constructor(db: Knex) {
    this.db = db;
  }

  async getActiveWithFilter(segmentId: string): Promise<SegmentWithFilter | null> {
    const cached = this.cache.get(segmentId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.value;
    }

    const row = await this.db.raw(
      `SELECT s.*, v.filter
       FROM audience_segments s
       LEFT JOIN audience_segment_versions v
         ON v.segment_id = s.id AND v.version = s.active_version
       WHERE s.id = ?`,
      [segmentId],
    );

    const result = row.rows?.[0] ?? null;

    if (!result || result.status !== 'active' || result.active_version == null) {
      return null;
    }

    const segment: SegmentWithFilter = {
      id: result.id,
      name: result.name,
      status: result.status,
      active_version: result.active_version,
      current_version: result.current_version,
      filter: result.filter,
    };

    this.cache.set(segmentId, {
      value: segment,
      expiresAt: Date.now() + TTL_MS,
    });

    return segment;
  }

  invalidate(segmentId: string): void {
    this.cache.delete(segmentId);
  }
}
