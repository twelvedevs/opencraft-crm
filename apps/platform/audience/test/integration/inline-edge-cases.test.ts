import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DB_URL, setupTestApp, truncateTables, type TestContext } from './setup.js';

describe.skipIf(!DB_URL)('inline edge cases integration', () => {
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

  const eqFilter = { op: 'AND', conditions: [{ field: 'status', op: 'eq', value: 'active' }] };

  // (a) snapshot:false + done:false → 400
  it('rejects snapshot:false with done:false', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/evaluate',
      payload: {
        filter: eqFilter,
        entities: [{ entity_id: 'e1', status: 'active' }],
        done: false,
        snapshot: false,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].code).toBe('INVALID_REQUEST');
  });

  // (b) snapshot:true + missing snapshot_id → 400
  it('rejects snapshot:true without snapshot_id', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/evaluate',
      payload: {
        filter: eqFilter,
        entities: [{ entity_id: 'e1', status: 'active' }],
        done: true,
        snapshot: true,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].code).toBe('MISSING_SNAPSHOT_ID');
  });

  // (c) inline snapshot filter mismatch → 400
  it('rejects filter mismatch on inline snapshot', async () => {
    const snapshotId = randomUUID();

    // First batch with filter A
    await ctx.app.inject({
      method: 'POST',
      url: '/audiences/evaluate',
      payload: {
        snapshot_id: snapshotId,
        filter: eqFilter,
        entities: [{ entity_id: 'e1', status: 'active' }],
        done: false,
        snapshot: true,
      },
    });

    // Second batch with different filter → 400
    const differentFilter = { op: 'AND', conditions: [{ field: 'name', op: 'eq', value: 'test' }] };
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/audiences/evaluate',
      payload: {
        snapshot_id: snapshotId,
        filter: differentFilter,
        entities: [{ entity_id: 'e2', name: 'test' }],
        done: true,
        snapshot: true,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].code).toBe('FILTER_MISMATCH');
  });

  // (d) GET /health → 200
  it('health endpoint returns ok', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });
});
