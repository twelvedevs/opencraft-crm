import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DB_URL, setupTestApp, truncateTables, type TestContext } from './setup.js';

describe.skipIf(!DB_URL)('evaluate integration', () => {
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

  async function createAndActivateSegment(filter: unknown = eqFilter): Promise<string> {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/segments',
      payload: { name: 'Test Segment', filter },
    });
    const { segment_id } = createRes.json();
    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segment_id}/activate`,
    });
    return segment_id;
  }

  // (a) full named segment flow
  it('named segment: create → activate → evaluate 2 batches → GET snapshot', async () => {
    const segmentId = await createAndActivateSegment();
    const snapshotId = randomUUID();

    // Batch 1 (done: false)
    const batch1 = await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segmentId}/evaluate`,
      payload: {
        snapshot_id: snapshotId,
        entities: [
          { entity_id: 'e1', pipeline: 'new_patient' },
          { entity_id: 'e2', pipeline: 'returning' },
        ],
        done: false,
      },
    });
    expect(batch1.statusCode).toBe(200);
    expect(batch1.json().matched_count).toBe(1);
    expect(batch1.json().status).toBe('accumulating');

    // Batch 2 (done: true)
    const batch2 = await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segmentId}/evaluate`,
      payload: {
        snapshot_id: snapshotId,
        entities: [
          { entity_id: 'e3', pipeline: 'new_patient' },
          { entity_id: 'e4', pipeline: 'new_patient' },
        ],
        done: true,
      },
    });
    expect(batch2.statusCode).toBe(200);
    expect(batch2.json().matched_count).toBe(3);
    expect(batch2.json().status).toBe('ready');

    // GET snapshot
    const snap = await ctx.app.inject({
      method: 'GET',
      url: `/audiences/snapshots/${snapshotId}`,
    });
    expect(snap.statusCode).toBe(200);
    const snapBody = snap.json();
    expect(snapBody.status).toBe('ready');
    expect(snapBody.matched_count).toBe(3);
    expect(snapBody.segment_id).toBe(segmentId);
    expect(snapBody.segment_version).toBe(1);
    expect(snapBody.entity_ids).toEqual(expect.arrayContaining(['e1', 'e3', 'e4']));
    expect(snapBody.entity_ids).toHaveLength(3);
  });

  // (b) GET snapshot while accumulating → partial entity_ids
  it('returns partial results while snapshot is accumulating', async () => {
    const segmentId = await createAndActivateSegment();
    const snapshotId = randomUUID();

    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segmentId}/evaluate`,
      payload: {
        snapshot_id: snapshotId,
        entities: [{ entity_id: 'e1', pipeline: 'new_patient' }],
        done: false,
      },
    });

    const snap = await ctx.app.inject({
      method: 'GET',
      url: `/audiences/snapshots/${snapshotId}`,
    });
    expect(snap.statusCode).toBe(200);
    expect(snap.json().status).toBe('accumulating');
    expect(snap.json().entity_ids).toContain('e1');
  });

  // (c) inline snapshot:false → no DB row
  it('inline evaluate without snapshot writes no DB rows', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/evaluate',
      payload: {
        filter: eqFilter,
        entities: [
          { entity_id: 'e1', pipeline: 'new_patient' },
          { entity_id: 'e2', pipeline: 'returning' },
        ],
        done: true,
        snapshot: false,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.matched_count).toBe(1);
    expect(body.entity_ids).toEqual(['e1']);

    // No snapshot row in DB
    const snapshots = await ctx.db('audience_snapshots').select('*');
    expect(snapshots).toHaveLength(0);
  });

  // (d) inline snapshot:true → snapshot row with segment_id=null
  it('inline evaluate with snapshot creates row with null segment_id', async () => {
    const snapshotId = randomUUID();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/evaluate',
      payload: {
        snapshot_id: snapshotId,
        filter: eqFilter,
        entities: [{ entity_id: 'e1', pipeline: 'new_patient' }],
        done: true,
        snapshot: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().snapshot_id).toBe(snapshotId);

    const snap = await ctx.app.inject({
      method: 'GET',
      url: `/audiences/snapshots/${snapshotId}`,
    });
    expect(snap.json().segment_id).toBeNull();
    expect(snap.json().segment_version).toBeNull();
  });

  // (e) duplicate entity_id → single member row
  it('deduplicates entity_ids across batches', async () => {
    const segmentId = await createAndActivateSegment();
    const snapshotId = randomUUID();

    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segmentId}/evaluate`,
      payload: {
        snapshot_id: snapshotId,
        entities: [{ entity_id: 'e1', pipeline: 'new_patient' }],
        done: false,
      },
    });

    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segmentId}/evaluate`,
      payload: {
        snapshot_id: snapshotId,
        entities: [{ entity_id: 'e1', pipeline: 'new_patient' }],
        done: true,
      },
    });

    // Only one member row
    const members = await ctx.db('audience_snapshot_members')
      .where({ snapshot_id: snapshotId });
    expect(members).toHaveLength(1);
  });

  // (f) sealed snapshot + subsequent batch → 400
  it('rejects batch on sealed snapshot', async () => {
    const segmentId = await createAndActivateSegment();
    const snapshotId = randomUUID();

    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segmentId}/evaluate`,
      payload: {
        snapshot_id: snapshotId,
        entities: [{ entity_id: 'e1', pipeline: 'new_patient' }],
        done: true,
      },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segmentId}/evaluate`,
      payload: {
        snapshot_id: snapshotId,
        entities: [{ entity_id: 'e2', pipeline: 'new_patient' }],
        done: false,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].code).toBe('SNAPSHOT_ALREADY_SEALED');
  });

  // (g) batch >1000 entities → 413
  it('rejects batch exceeding 1000 entities', async () => {
    const segmentId = await createAndActivateSegment();
    const entities = Array.from({ length: 1001 }, (_, i) => ({
      entity_id: `e${i}`,
      pipeline: 'new_patient',
    }));

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segmentId}/evaluate`,
      payload: {
        snapshot_id: randomUUID(),
        entities,
        done: true,
      },
    });
    expect(res.statusCode).toBe(413);
  });

  // (h) total snapshot cap: mock getMatchedCount to 99999, submit batch of 2 matching → 400
  it('rejects batch that would exceed 100k cap', async () => {
    const segmentId = await createAndActivateSegment();
    const snapshotId = randomUUID();

    // Create a snapshot row and manually set matched_count high
    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segmentId}/evaluate`,
      payload: {
        snapshot_id: snapshotId,
        entities: [{ entity_id: 'e1', pipeline: 'new_patient' }],
        done: false,
      },
    });

    // Manually update matched_count to 99999
    await ctx.db('audience_snapshots')
      .where({ id: snapshotId })
      .update({ matched_count: 99999 });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segmentId}/evaluate`,
      payload: {
        snapshot_id: snapshotId,
        entities: [
          { entity_id: 'e2', pipeline: 'new_patient' },
          { entity_id: 'e3', pipeline: 'new_patient' },
        ],
        done: false,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].code).toBe('SNAPSHOT_SIZE_EXCEEDED');
  });

  // (i) cross-segment snapshot pollution → 400
  it('rejects snapshot_id used with different segment', async () => {
    const segmentId1 = await createAndActivateSegment();
    const segmentId2 = await createAndActivateSegment();
    const snapshotId = randomUUID();

    // Use snapshot with segment 1
    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segmentId1}/evaluate`,
      payload: {
        snapshot_id: snapshotId,
        entities: [{ entity_id: 'e1', pipeline: 'new_patient' }],
        done: false,
      },
    });

    // Try with segment 2 → 400
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segmentId2}/evaluate`,
      payload: {
        snapshot_id: snapshotId,
        entities: [{ entity_id: 'e2', pipeline: 'new_patient' }],
        done: false,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].code).toBe('SEGMENT_MISMATCH');
  });
});
