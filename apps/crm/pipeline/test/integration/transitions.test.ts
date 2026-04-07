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

describe.skipIf(!HAS_DB)('Transition endpoints (integration)', () => {
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
  async function enroll(
    opts: { pipeline?: string; stage?: string; lead_id?: string; timeout_at?: string } = {},
  ) {
    const res = await app.inject({
      method: 'POST',
      url: '/pipeline/memberships',
      headers: { 'x-internal-api-key': API_KEY },
      payload: {
        lead_id: opts.lead_id ?? LEAD_ID_1,
        location_id: LOCATION_ID,
        pipeline: opts.pipeline ?? 'new_patient',
        stage: opts.stage ?? 'new_lead',
        reason: 'manual',
        ...(opts.timeout_at ? { timeout_at: opts.timeout_at } : {}),
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  /** Helper: transition a membership */
  async function transition(
    id: string,
    body: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'POST',
      url: `/pipeline/memberships/${id}/transition`,
      headers: { 'x-internal-api-key': API_KEY },
      payload: body,
    });
  }

  // ── Valid transition ──────────────────────────────────────

  it('valid transition: new_lead → contacted', async () => {
    const m = await enroll();
    mockDriver.published.length = 0;

    const res = await transition(m.id, {
      stage: 'contacted',
      override: false,
      triggered_by: TRIGGERED_BY,
      reason: 'manual',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stage).toBe('contacted');
    expect(body.previous_stage).toBe('new_lead');

    // History row
    const histRes = await app.inject({
      method: 'GET',
      url: `/pipeline/memberships/${m.id}/history`,
      headers: { 'x-internal-api-key': API_KEY },
    });
    const history = histRes.json();
    // enrollment + transition = 2 rows
    expect(history).toHaveLength(2);
    expect(history[1].stage_from).toBe('new_lead');
    expect(history[1].stage_to).toBe('contacted');

    // Event published
    expect(mockDriver.published).toHaveLength(1);
    const event = mockDriver.published[0];
    expect(event.event_type).toBe('lead.stage_changed');
    const payload = event.payload as Record<string, unknown>;
    expect(payload.stage_from).toBe('new_lead');
    expect(payload.stage_to).toBe('contacted');
  });

  // ── Invalid transition ────────────────────────────────────

  it('invalid transition: new_lead → tx_presented → 422', async () => {
    const m = await enroll();
    mockDriver.published.length = 0;

    const res = await transition(m.id, {
      stage: 'tx_presented',
      override: false,
      triggered_by: TRIGGERED_BY,
      reason: 'manual',
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe('invalid_transition');
    expect(body.from).toBe('new_lead');
    expect(body.to).toBe('tx_presented');
    expect(body.allowed).toEqual(['contacted', 'lost']);

    // No history row for the failed transition (only enrollment)
    const histRes = await app.inject({
      method: 'GET',
      url: `/pipeline/memberships/${m.id}/history`,
      headers: { 'x-internal-api-key': API_KEY },
    });
    expect(histRes.json()).toHaveLength(1);

    // No event published
    expect(mockDriver.published).toHaveLength(0);
  });

  // ── Override ──────────────────────────────────────────────

  it('override: new_lead → tx_presented with override:true → 200', async () => {
    const m = await enroll();
    mockDriver.published.length = 0;

    const res = await transition(m.id, {
      stage: 'tx_presented',
      override: true,
      triggered_by: TRIGGERED_BY,
      reason: 'manual',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stage).toBe('tx_presented');
    expect(body.last_transition_override).toBe(true);
  });

  it('override without triggered_by → 400', async () => {
    const m = await enroll();
    mockDriver.published.length = 0;

    const res = await transition(m.id, {
      stage: 'tx_presented',
      override: true,
      triggered_by: null,
      reason: 'manual',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('override_requires_triggered_by');
  });

  // ── recall_due ────────────────────────────────────────────

  it('recall_due transition without timeout_at → 400', async () => {
    // Enroll in retention at active_retention, then transition to recall_due
    const m = await enroll({ pipeline: 'in_retention', stage: 'active_retention' });
    mockDriver.published.length = 0;

    const res = await transition(m.id, {
      stage: 'recall_due',
      override: false,
      triggered_by: TRIGGERED_BY,
      reason: 'manual',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('timeout_at_required');
  });

  it('recall_due transition with timeout_at → 200', async () => {
    const m = await enroll({ pipeline: 'in_retention', stage: 'active_retention' });
    mockDriver.published.length = 0;

    const futureDate = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const res = await transition(m.id, {
      stage: 'recall_due',
      override: false,
      triggered_by: TRIGGERED_BY,
      reason: 'manual',
      timeout_at: futureDate,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stage).toBe('recall_due');
    expect(new Date(body.timeout_at).toISOString()).toBe(new Date(futureDate).toISOString());
  });

  // ── Inactive membership ───────────────────────────────────

  it('transition on inactive membership → 409', async () => {
    const m = await enroll();
    // Close the membership first
    await app.inject({
      method: 'POST',
      url: `/pipeline/memberships/${m.id}/close`,
      headers: { 'x-internal-api-key': API_KEY },
      payload: { triggered_by: TRIGGERED_BY, closed_reason: 'import_undo' },
    });
    mockDriver.published.length = 0;

    const res = await transition(m.id, {
      stage: 'contacted',
      override: false,
      triggered_by: TRIGGERED_BY,
      reason: 'manual',
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('membership_not_active');
  });

  // ── Unknown membership ────────────────────────────────────

  it('unknown membership id → 404', async () => {
    const res = await transition('00000000-0000-0000-0000-000000000099', {
      stage: 'contacted',
      override: false,
      triggered_by: TRIGGERED_BY,
      reason: 'manual',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  // ── Concurrent transitions ────────────────────────────────

  it('concurrent identical transitions: only one succeeds', async () => {
    const m = await enroll();
    mockDriver.published.length = 0;

    const payload = {
      stage: 'contacted',
      override: false,
      triggered_by: TRIGGERED_BY,
      reason: 'manual',
    };

    // Fire two transitions simultaneously
    const [r1, r2] = await Promise.all([
      transition(m.id, payload),
      transition(m.id, payload),
    ]);

    const statuses = [r1.statusCode, r2.statusCode].sort();
    // One should be 200, the other 422 (already at contacted → invalid same-stage transition)
    expect(statuses).toContain(200);
    expect([409, 422]).toContain(statuses[0] === 200 ? statuses[1] : statuses[0]);

    // Exactly one history row for the transition (plus enrollment = 2 total)
    const histRes = await app.inject({
      method: 'GET',
      url: `/pipeline/memberships/${m.id}/history`,
      headers: { 'x-internal-api-key': API_KEY },
    });
    expect(histRes.json()).toHaveLength(2);

    // Exactly one event published
    expect(mockDriver.published).toHaveLength(1);
  });

  // ── time_in_stage_seconds ─────────────────────────────────

  it('time_in_stage_seconds is > 0 when entered_stage_at is in the past', async () => {
    const m = await enroll({ stage: 'contacted' });
    mockDriver.published.length = 0;

    // Directly update entered_stage_at to 1 hour ago
    const { getDb } = await import('./helpers.js');
    const db = getDb();
    const pastDate = new Date(Date.now() - 3600_000);
    await db('pipeline_memberships')
      .where({ id: m.id })
      .update({ entered_stage_at: pastDate });

    const res = await transition(m.id, {
      stage: 'exam_scheduled',
      override: false,
      triggered_by: TRIGGERED_BY,
      reason: 'manual',
    });

    expect(res.statusCode).toBe(200);
    expect(mockDriver.published).toHaveLength(1);
    const payload = mockDriver.published[0].payload as Record<string, unknown>;
    expect(payload.time_in_stage_seconds).toBeGreaterThan(0);
  });

  // ── response_time_seconds ─────────────────────────────────

  it('response_time_seconds is present when transitioning to contacted with triggered_by', async () => {
    const m = await enroll();
    mockDriver.published.length = 0;

    const res = await transition(m.id, {
      stage: 'contacted',
      override: false,
      triggered_by: TRIGGERED_BY,
      reason: 'manual',
    });

    expect(res.statusCode).toBe(200);
    const payload = mockDriver.published[0].payload as Record<string, unknown>;
    expect(payload.response_time_seconds).toBeTypeOf('number');
    expect(payload.response_time_seconds as number).toBeGreaterThanOrEqual(0);
  });

  it('response_time_seconds is null when triggered_by is null', async () => {
    const m = await enroll();
    mockDriver.published.length = 0;

    const res = await transition(m.id, {
      stage: 'contacted',
      override: false,
      reason: 'manual',
    });

    expect(res.statusCode).toBe(200);
    const payload = mockDriver.published[0].payload as Record<string, unknown>;
    expect(payload.response_time_seconds).toBeNull();
  });
});
