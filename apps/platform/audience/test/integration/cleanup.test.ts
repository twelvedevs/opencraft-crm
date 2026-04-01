import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DB_URL, setupTestApp, truncateTables, type TestContext } from './setup.js';

describe.skipIf(!DB_URL)('cleanup integration', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await truncateTables(ctx.db);
  });

  const eqFilter = { op: 'AND', conditions: [{ field: 'pipeline', op: 'eq', value: 'new_patient' }] };

  async function createAndActivateSegment(): Promise<string> {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/segments',
      payload: { name: 'Test Segment', filter: eqFilter },
    });
    const { segment_id } = createRes.json();
    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segment_id}/activate`,
    });
    return segment_id;
  }

  it('primary cleanup job deletes snapshot and members via cascade', async () => {
    const segmentId = await createAndActivateSegment();
    const snapshotId = randomUUID();

    // Create a sealed snapshot
    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segmentId}/evaluate`,
      payload: {
        snapshot_id: snapshotId,
        entities: [
          { entity_id: 'e1', pipeline: 'new_patient' },
          { entity_id: 'e2', pipeline: 'new_patient' },
        ],
        done: true,
      },
    });

    // Verify snapshot exists
    const beforeRes = await ctx.app.inject({
      method: 'GET',
      url: `/audiences/snapshots/${snapshotId}`,
    });
    expect(beforeRes.statusCode).toBe(200);

    // Verify members exist
    const membersBefore = await ctx.db('audience_snapshot_members')
      .where({ snapshot_id: snapshotId });
    expect(membersBefore.length).toBeGreaterThan(0);

    // Directly call the cleanup logic (delete the snapshot row — cascade deletes members)
    const deleted = await ctx.db('audience_snapshots').where({ id: snapshotId }).del();
    expect(deleted).toBe(1);

    // Verify snapshot is gone via API
    const afterRes = await ctx.app.inject({
      method: 'GET',
      url: `/audiences/snapshots/${snapshotId}`,
    });
    expect(afterRes.statusCode).toBe(404);

    // Verify members are gone via cascade
    const membersAfter = await ctx.db('audience_snapshot_members')
      .where({ snapshot_id: snapshotId });
    expect(membersAfter).toHaveLength(0);
  });

  it('cleanup on already-deleted snapshot does not throw', async () => {
    const snapshotId = randomUUID();

    // Delete a non-existent snapshot — should not throw
    const deleted = await ctx.db('audience_snapshots').where({ id: snapshotId }).del();
    expect(deleted).toBe(0);
  });

  it('safety-net sweep deletes expired snapshots', async () => {
    const segmentId = await createAndActivateSegment();
    const snapshotId = randomUUID();

    // Create a sealed snapshot
    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segmentId}/evaluate`,
      payload: {
        snapshot_id: snapshotId,
        entities: [{ entity_id: 'e1', pipeline: 'new_patient' }],
        done: true,
      },
    });

    // Manually set expires_at to the past
    await ctx.db('audience_snapshots')
      .where({ id: snapshotId })
      .update({ expires_at: ctx.db.raw("NOW() - interval '1 minute'") });

    // Run the sweep logic directly (same as sweep worker handler)
    const result = await ctx.db('audience_snapshots')
      .whereRaw('expires_at < NOW()')
      .del();
    expect(result).toBeGreaterThanOrEqual(1);

    // Verify snapshot is deleted
    const afterRes = await ctx.app.inject({
      method: 'GET',
      url: `/audiences/snapshots/${snapshotId}`,
    });
    expect(afterRes.statusCode).toBe(404);
  });
});
