import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DB_URL, setupTestApp, truncateTables, type TestContext } from './setup.js';

describe.skipIf(!DB_URL)('segments integration', () => {
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

  const validFilter = { op: 'AND', conditions: [{ field: 'status', op: 'eq', value: 'active' }] };

  // (a) POST /audiences/segments with valid filter → 201
  it('creates a segment with valid filter', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/segments',
      payload: { name: 'Test Segment', filter: validFilter },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.segment_id).toBeDefined();
    expect(body.version).toBe(1);
    expect(body.status).toBe('draft');

    // Verify rows in DB
    const seg = await ctx.db('audience_segments').where({ id: body.segment_id }).first();
    expect(seg).toBeDefined();
    expect(seg.name).toBe('Test Segment');
    const ver = await ctx.db('audience_segment_versions').where({ segment_id: body.segment_id, version: 1 }).first();
    expect(ver).toBeDefined();
  });

  // (b) POST /audiences/segments without filter → 400
  it('rejects segment creation without filter', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/segments',
      payload: { name: 'Bad Segment', filter: null },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.errors[0].code).toBe('INVALID_REQUEST');
  });

  // (c) GET /audiences/segments/:id for draft → filter: null, active_version: null
  it('returns null filter and active_version for draft segment', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/segments',
      payload: { name: 'Draft Seg', filter: validFilter },
    });
    const { segment_id } = createRes.json();

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/audiences/segments/${segment_id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.filter).toBeNull();
    expect(body.active_version).toBeNull();
    expect(body.status).toBe('draft');
  });

  // (d) PUT on unactivated draft → version row overwritten, current_version unchanged
  it('overwrites draft filter on PUT before activation', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/segments',
      payload: { name: 'Draft', filter: validFilter },
    });
    const { segment_id } = createRes.json();

    const newFilter = { op: 'AND', conditions: [{ field: 'name', op: 'eq', value: 'updated' }] };
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/audiences/segments/${segment_id}`,
      payload: { filter: newFilter },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version).toBe(1); // current_version unchanged

    // Verify filter was overwritten
    const ver = await ctx.db('audience_segment_versions').where({ segment_id, version: 1 }).first();
    expect(ver.filter).toEqual(newFilter);
  });

  // (e) POST /audiences/segments/:id/activate → status='active', active_version=1
  it('activates a segment', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/segments',
      payload: { name: 'To Activate', filter: validFilter },
    });
    const { segment_id } = createRes.json();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segment_id}/activate`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('active');
    expect(body.active_version).toBe(1);
  });

  // (f) GET /audiences/segments/:id after activate → filter returned
  it('returns filter after activation', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/segments',
      payload: { name: 'Active Seg', filter: validFilter },
    });
    const { segment_id } = createRes.json();

    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segment_id}/activate`,
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/audiences/segments/${segment_id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.filter).toEqual(validFilter);
    expect(body.status).toBe('active');
    expect(body.active_version).toBe(1);
  });

  // (g) PUT after activate → new version row, current_version=2
  it('creates new version on PUT after activation', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/segments',
      payload: { name: 'Versioned', filter: validFilter },
    });
    const { segment_id } = createRes.json();

    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segment_id}/activate`,
    });

    const newFilter = { op: 'OR', conditions: [{ field: 'age', op: 'gt', value: 18 }] };
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/audiences/segments/${segment_id}`,
      payload: { filter: newFilter },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version).toBe(2);

    // Both version rows should exist
    const versions = await ctx.db('audience_segment_versions')
      .where({ segment_id })
      .orderBy('version');
    expect(versions).toHaveLength(2);
    expect(versions[0].filter).toEqual(validFilter);
    expect(versions[1].filter).toEqual(newFilter);
  });

  // (h) POST /audiences/segments/:id/disable → status='disabled'
  it('disables a segment', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/segments',
      payload: { name: 'To Disable', filter: validFilter },
    });
    const { segment_id } = createRes.json();

    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segment_id}/activate`,
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segment_id}/disable`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('disabled');
  });

  // (i) GET /audiences/segments?status=active → only active
  it('filters segments by status', async () => {
    // Create active segment
    const res1 = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/segments',
      payload: { name: 'Active One', filter: validFilter },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${res1.json().segment_id}/activate`,
    });

    // Create draft segment
    await ctx.app.inject({
      method: 'POST',
      url: '/audiences/segments',
      payload: { name: 'Draft One', filter: validFilter },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/audiences/segments?status=active',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].status).toBe('active');
  });

  // (j) GET /audiences/segments?status=active,draft → both
  it('filters segments by multiple statuses', async () => {
    const res1 = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/segments',
      payload: { name: 'Active', filter: validFilter },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${res1.json().segment_id}/activate`,
    });

    await ctx.app.inject({
      method: 'POST',
      url: '/audiences/segments',
      payload: { name: 'Draft', filter: validFilter },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/audiences/segments?status=active,draft',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  // (k) pagination
  it('paginates segments correctly', async () => {
    for (let i = 0; i < 5; i++) {
      await ctx.app.inject({
        method: 'POST',
        url: '/audiences/segments',
        payload: { name: `Seg ${i}`, filter: validFilter },
      });
    }

    const page1 = await ctx.app.inject({
      method: 'GET',
      url: '/audiences/segments?limit=2&offset=0',
    });
    expect(page1.json().data).toHaveLength(2);
    expect(page1.json().total).toBe(5);

    const page2 = await ctx.app.inject({
      method: 'GET',
      url: '/audiences/segments?limit=2&offset=2',
    });
    expect(page2.json().data).toHaveLength(2);
    expect(page2.json().total).toBe(5);
  });
});
