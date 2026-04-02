import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DB_URL, setupTestApp, truncateTables, type TestContext } from './setup.js';

describe.skipIf(!DB_URL)('error format integration', () => {
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

  it('POST /audiences/segments without filter returns JSON:API 400', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/segments',
      payload: { name: 'No Filter Segment' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors[0].status).toBe('400');
    expect(body.errors[0].code).toBe('INVALID_REQUEST');
  });

  it('GET /audiences/segments/:id with non-existent id returns JSON:API 404', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/audiences/segments/${randomUUID()}`,
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors[0].status).toBe('404');
  });

  it('POST /audiences/segments/:id/evaluate without snapshot_id returns MISSING_SNAPSHOT_ID', async () => {
    // Create and activate a segment first
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/segments',
      payload: { name: 'Test', filter: { op: 'AND', conditions: [{ field: 'x', op: 'eq', value: 1 }] } },
    });
    const { segment_id } = createRes.json();
    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segment_id}/activate`,
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segment_id}/evaluate`,
      payload: {
        snapshot_id: '',
        entities: [{ entity_id: 'e1', x: 1 }],
        done: true,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].code).toBe('MISSING_SNAPSHOT_ID');
  });

  it('POST /audiences/segments/:id/evaluate with >1000 entities returns 413', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/segments',
      payload: { name: 'Test', filter: { op: 'AND', conditions: [{ field: 'x', op: 'eq', value: 1 }] } },
    });
    const { segment_id } = createRes.json();
    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segment_id}/activate`,
    });

    const entities = Array.from({ length: 1001 }, (_, i) => ({ entity_id: `e${i}`, x: 1 }));
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segment_id}/evaluate`,
      payload: {
        snapshot_id: randomUUID(),
        entities,
        done: true,
      },
    });
    expect(res.statusCode).toBe(413);
  });

  it('POST /audiences/segments/:id/activate with no filter version returns NO_FILTER_VERSION', async () => {
    // Create a segment without any version row by inserting directly
    const segmentId = randomUUID();
    await ctx.db('audience_segments').insert({
      id: segmentId,
      name: 'Empty Segment',
      status: 'draft',
      current_version: 1,
      active_version: null,
      created_by: null,
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segmentId}/activate`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].code).toBe('NO_FILTER_VERSION');
  });
});
