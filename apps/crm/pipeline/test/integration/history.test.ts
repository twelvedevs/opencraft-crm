import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  HAS_DB,
  runMigrations,
  cleanup,
  truncateTables,
  buildTestApp,
  mockDriver,
  LOCATION_ID,
  LEAD_ID_1,
} from './helpers.js';

const API_KEY = 'test-key';
const TRIGGERED_BY = '00000000-0000-0000-0000-000000000099';

describe.skipIf(!HAS_DB)('History endpoints (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await runMigrations();
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
    mockDriver.published.length = 0;
  });

  /** Helper: enroll a lead and return the membership */
  async function enroll() {
    const res = await app.inject({
      method: 'POST',
      url: '/pipeline/memberships',
      headers: { 'x-internal-api-key': API_KEY },
      payload: {
        lead_id: LEAD_ID_1,
        location_id: LOCATION_ID,
        pipeline: 'new_patient',
        stage: 'new_lead',
        reason: 'manual',
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  /** Helper: transition a membership */
  async function transition(id: string, stage: string) {
    const res = await app.inject({
      method: 'POST',
      url: `/pipeline/memberships/${id}/transition`,
      headers: { 'x-internal-api-key': API_KEY },
      payload: {
        stage,
        override: false,
        triggered_by: TRIGGERED_BY,
        reason: 'manual',
      },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  // ── History after enrollment + 2 transitions ──────────────

  it('returns 3 history rows after enrollment + 2 transitions in ASC order', async () => {
    const m = await enroll();
    await transition(m.id, 'contacted');
    await transition(m.id, 'exam_scheduled');

    const res = await app.inject({
      method: 'GET',
      url: `/pipeline/memberships/${m.id}/history`,
      headers: { 'x-internal-api-key': API_KEY },
    });

    expect(res.statusCode).toBe(200);
    const history = res.json();
    expect(history).toHaveLength(3);

    // Row 0: enrollment (stage_from=null, stage_to=new_lead)
    expect(history[0].stage_from).toBeNull();
    expect(history[0].stage_to).toBe('new_lead');

    // Row 1: new_lead → contacted
    expect(history[1].stage_from).toBe('new_lead');
    expect(history[1].stage_to).toBe('contacted');

    // Row 2: contacted → exam_scheduled
    expect(history[2].stage_from).toBe('contacted');
    expect(history[2].stage_to).toBe('exam_scheduled');

    // Verify ASC order by transitioned_at
    const timestamps = history.map((h: Record<string, unknown>) => new Date(h.transitioned_at as string).getTime());
    expect(timestamps[0]).toBeLessThanOrEqual(timestamps[1]);
    expect(timestamps[1]).toBeLessThanOrEqual(timestamps[2]);
  });

  // ── Unknown membership → 404 ─────────────────────────────

  it('returns 404 for unknown membership id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pipeline/memberships/00000000-0000-0000-0000-000000000099/history',
      headers: { 'x-internal-api-key': API_KEY },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });
});
