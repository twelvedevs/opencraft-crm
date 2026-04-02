import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DB_URL, setupTestApp, truncateTables, type TestContext } from './setup.js';

describe.skipIf(!DB_URL)('check integration', () => {
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
      payload: { name: 'Check Segment', filter: eqFilter },
    });
    const { segment_id } = createRes.json();
    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segment_id}/activate`,
    });
    return segment_id;
  }

  // (a) active segment + matching entity → matches: true
  it('returns matches true for matching entity', async () => {
    const segmentId = await createAndActivateSegment();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segmentId}/check`,
      payload: { entity: { pipeline: 'new_patient' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.matches).toBe(true);
    expect(body.segment_id).toBe(segmentId);
    expect(body.segment_version).toBe(1);
  });

  // (b) active segment + non-matching entity → matches: false
  it('returns matches false for non-matching entity', async () => {
    const segmentId = await createAndActivateSegment();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segmentId}/check`,
      payload: { entity: { pipeline: 'returning' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().matches).toBe(false);
  });

  // (c) segment with no active version → 404
  it('returns 404 for draft segment', async () => {
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/segments',
      payload: { name: 'Draft', filter: eqFilter },
    });
    const { segment_id } = createRes.json();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segment_id}/check`,
      payload: { entity: { pipeline: 'new_patient' } },
    });
    expect(res.statusCode).toBe(404);
  });

  // (d) disabled segment → 404
  it('returns 404 for disabled segment', async () => {
    const segmentId = await createAndActivateSegment();

    await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segmentId}/disable`,
    });

    // Clear cache to ensure disabled state is picked up
    ctx.app.segmentRepository.invalidate(segmentId);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/audiences/segments/${segmentId}/check`,
      payload: { entity: { pipeline: 'new_patient' } },
    });
    expect(res.statusCode).toBe(404);
  });
});
