import type { Knex } from '../db.js';

export interface AudienceSnapshot {
  id: string;
  segment_id: string | null;
  segment_version: number | null;
  filter_snapshot: unknown;
  status: string;
  matched_count: number;
  expires_at: string;
  created_by: string | null;
  created_at: string;
}

export class SnapshotsRepository {
  private db: Knex;

  constructor(db: Knex) {
    this.db = db;
  }

  async createIfNotExists(data: {
    id: string;
    segment_id: string | null;
    segment_version: number | null;
    filter_snapshot: unknown;
    expires_at: Date;
    created_by: string | null;
  }): Promise<void> {
    await this.db.raw(
      `INSERT INTO audience_snapshots (id, segment_id, segment_version, filter_snapshot, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      [
        data.id,
        data.segment_id,
        data.segment_version,
        JSON.stringify(data.filter_snapshot),
        data.expires_at.toISOString(),
        data.created_by,
      ],
    );
  }

  async findById(id: string): Promise<AudienceSnapshot | null> {
    const row = await this.db('audience_snapshots').where({ id }).first();
    return (row as AudienceSnapshot) ?? null;
  }

  async addMembers(snapshotId: string, entityIds: string[]): Promise<number> {
    if (entityIds.length === 0) return 0;
    const result = await this.db.raw(
      `INSERT INTO audience_snapshot_members (snapshot_id, entity_id)
       SELECT ?, unnest(?::text[])
       ON CONFLICT DO NOTHING`,
      [snapshotId, entityIds],
    );
    return result.rowCount ?? 0;
  }

  async incrementMatchedCount(snapshotId: string, delta: number): Promise<void> {
    await this.db('audience_snapshots')
      .where({ id: snapshotId })
      .update({
        matched_count: this.db.raw('matched_count + ?', [delta]),
      });
  }

  async getMatchedCount(snapshotId: string): Promise<number> {
    const row = await this.db('audience_snapshots')
      .where({ id: snapshotId })
      .select('matched_count')
      .first();
    return row ? (row as { matched_count: number }).matched_count : 0;
  }

  async seal(snapshotId: string): Promise<void> {
    await this.db('audience_snapshots')
      .where({ id: snapshotId })
      .update({ status: 'ready' });
  }

  async findMembers(snapshotId: string, limit: number, offset: number): Promise<string[]> {
    const rows = await this.db('audience_snapshot_members')
      .where({ snapshot_id: snapshotId })
      .select('entity_id')
      .orderBy('entity_id')
      .limit(limit)
      .offset(offset);
    return rows.map((r: { entity_id: string }) => r.entity_id);
  }

  async validateSegmentId(snapshotId: string, expectedSegmentId: string): Promise<boolean> {
    const snapshot = await this.findById(snapshotId);
    if (!snapshot) return true; // New snapshot, no conflict
    return snapshot.segment_id === expectedSegmentId;
  }
}
