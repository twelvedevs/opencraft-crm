import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DB_URL, setupTestApp, truncateTables, type TestContext } from './setup.js';

describe.skipIf(!DB_URL)('filter snapshot audit integration', () => {
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

  const filterA = { op: 'AND', conditions: [{ field: 'pipeline', op: 'eq', value: 'new_patient' }] };
  const filterB = { op: 'AND', conditions: [{ field: 'pipeline', op: 'eq', value: 'returning' }] };

  it('snapshot retains original filter after segment filter is updated', async () => {
    // Create segment with filter A and activate
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/segments',
      payload: { name: 'Audit Segment', filter: filterA },
    });
    const { segment_id } = createRes.json();
    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segment_id}/activate`,
    });

    // Evaluate with filter A → creates snapshot with filter_snapshot = filterA
    const snapshotIdA = randomUUID();
    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segment_id}/evaluate`,
      payload: {
        snapshot_id: snapshotIdA,
        entities: [{ entity_id: 'e1', pipeline: 'new_patient' }],
        done: true,
      },
    });

    // Update segment to filter B and activate new version
    await ctx.app.inject({
      method: 'PUT',
      url: `/audiences/segments/${segment_id}`,
      payload: { filter: filterB },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segment_id}/activate`,
    });

    // Verify snapshot A still has filter_snapshot = filterA (read directly from DB)
    const snapshotRow = await ctx.db('audience_snapshots')
      .where({ id: snapshotIdA })
      .first();
    expect(snapshotRow).toBeDefined();
    // filter_snapshot is stored as jsonb, Knex returns it as a parsed object
    expect(snapshotRow.filter_snapshot).toEqual(filterA);
  });

  it('new evaluate after filter update creates snapshot with new filter', async () => {
    // Create segment with filter A and activate
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/segments',
      payload: { name: 'Audit Segment', filter: filterA },
    });
    const { segment_id } = createRes.json();
    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segment_id}/activate`,
    });

    // Evaluate with filter A
    const snapshotIdA = randomUUID();
    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segment_id}/evaluate`,
      payload: {
        snapshot_id: snapshotIdA,
        entities: [{ entity_id: 'e1', pipeline: 'new_patient' }],
        done: true,
      },
    });

    // Update segment to filter B and activate
    await ctx.app.inject({
      method: 'PUT',
      url: `/audiences/segments/${segment_id}`,
      payload: { filter: filterB },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segment_id}/activate`,
    });
    // Invalidate cache so next evaluate picks up new filter
    ctx.app.segmentRepository.invalidate(segment_id);

    // Evaluate with new filter B
    const snapshotIdB = randomUUID();
    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segment_id}/evaluate`,
      payload: {
        snapshot_id: snapshotIdB,
        entities: [{ entity_id: 'e2', pipeline: 'returning' }],
        done: true,
      },
    });

    // Verify snapshot B has filter_snapshot = filterB
    const snapshotRowB = await ctx.db('audience_snapshots')
      .where({ id: snapshotIdB })
      .first();
    expect(snapshotRowB).toBeDefined();
    expect(snapshotRowB.filter_snapshot).toEqual(filterB);

    // Verify snapshot A still has filter_snapshot = filterA
    const snapshotRowA = await ctx.db('audience_snapshots')
      .where({ id: snapshotIdA })
      .first();
    expect(snapshotRowA.filter_snapshot).toEqual(filterA);
  });
});
