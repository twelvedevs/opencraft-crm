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

describe.skipIf(!HAS_DB)('Close endpoints (integration)', () => {
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

  // ── Valid close ───────────────────────────────────────────

  it('closes a membership with import_undo', async () => {
    const m = await enroll();
    mockDriver.published.length = 0;

    const res = await app.inject({
      method: 'POST',
      url: `/pipeline/memberships/${m.id}/close`,
      headers: { 'x-internal-api-key': API_KEY },
      payload: { triggered_by: TRIGGERED_BY, closed_reason: 'import_undo' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('closed');
    expect(body.closed_reason).toBe('import_undo');
    expect(body.closed_at).toBeTruthy();

    // NO history row inserted (close does not insert history)
    const histRes = await app.inject({
      method: 'GET',
      url: `/pipeline/memberships/${m.id}/history`,
      headers: { 'x-internal-api-key': API_KEY },
    });
    const history = histRes.json();
    // Only the enrollment history row (no close row)
    expect(history).toHaveLength(1);
    expect(history[0].stage_to).toBe('new_lead');

    // NO event published after close
    expect(mockDriver.published).toHaveLength(0);
  });

  // ── Missing triggered_by → 400 ────────────────────────────

  it('close without triggered_by → 400', async () => {
    const m = await enroll();
    mockDriver.published.length = 0;

    const res = await app.inject({
      method: 'POST',
      url: `/pipeline/memberships/${m.id}/close`,
      headers: { 'x-internal-api-key': API_KEY },
      payload: { closed_reason: 'import_undo' },
    });

    expect(res.statusCode).toBe(400);
  });

  // ── Inactive membership → 409 ─────────────────────────────

  it('close on already-closed membership → 409', async () => {
    const m = await enroll();

    // Close once
    await app.inject({
      method: 'POST',
      url: `/pipeline/memberships/${m.id}/close`,
      headers: { 'x-internal-api-key': API_KEY },
      payload: { triggered_by: TRIGGERED_BY, closed_reason: 'import_undo' },
    });
    mockDriver.published.length = 0;

    // Close again
    const res = await app.inject({
      method: 'POST',
      url: `/pipeline/memberships/${m.id}/close`,
      headers: { 'x-internal-api-key': API_KEY },
      payload: { triggered_by: TRIGGERED_BY, closed_reason: 'import_undo' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('membership_not_active');
  });

  // ── Unknown id → 404 ──────────────────────────────────────

  it('close unknown membership → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/pipeline/memberships/00000000-0000-0000-0000-000000000099/close',
      headers: { 'x-internal-api-key': API_KEY },
      payload: { triggered_by: TRIGGERED_BY, closed_reason: 'import_undo' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });
});
