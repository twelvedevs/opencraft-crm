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
  LEAD_ID_2,
} from './helpers.js';

const API_KEY = 'test-key';
const LEAD_ID_3 = '00000000-0000-0000-0000-000000000012';

describe.skipIf(!HAS_DB)('Membership endpoints (integration)', () => {
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

  // ── Enrollment ────────────────────────────────────────────

  it('enrolls a lead and returns 201 with correct fields', async () => {
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
    const body = res.json();
    expect(body.lead_id).toBe(LEAD_ID_1);
    expect(body.location_id).toBe(LOCATION_ID);
    expect(body.pipeline).toBe('new_patient');
    expect(body.stage).toBe('new_lead');
    expect(body.status).toBe('active');
    expect(body.id).toBeDefined();

    // stage_history row inserted with stage_from=null
    const historyRes = await app.inject({
      method: 'GET',
      url: `/pipeline/memberships/${body.id}/history`,
      headers: { 'x-internal-api-key': API_KEY },
    });
    const history = historyRes.json();
    expect(history).toHaveLength(1);
    expect(history[0].stage_from).toBeNull();
    expect(history[0].stage_to).toBe('new_lead');

    // lead.stage_changed published with stage_from: null
    expect(mockDriver.published).toHaveLength(1);
    const event = mockDriver.published[0];
    expect(event.event_type).toBe('lead.stage_changed');
    expect((event.payload as Record<string, unknown>).stage_from).toBeNull();
  });

  it('returns 409 when enrolling duplicate lead_id + pipeline', async () => {
    const payload = {
      lead_id: LEAD_ID_1,
      location_id: LOCATION_ID,
      pipeline: 'new_patient',
      stage: 'new_lead',
      reason: 'manual',
    };

    const first = await app.inject({
      method: 'POST',
      url: '/pipeline/memberships',
      headers: { 'x-internal-api-key': API_KEY },
      payload,
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/pipeline/memberships',
      headers: { 'x-internal-api-key': API_KEY },
      payload,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('membership_already_active');
  });

  it('returns 400 when enrolling recall_due without timeout_at', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/pipeline/memberships',
      headers: { 'x-internal-api-key': API_KEY },
      payload: {
        lead_id: LEAD_ID_1,
        location_id: LOCATION_ID,
        pipeline: 'in_retention',
        stage: 'recall_due',
        reason: 'manual',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('timeout_at_required');
  });

  it('enrolls recall_due with timeout_at → 201 with correct timeout', async () => {
    const futureDate = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const res = await app.inject({
      method: 'POST',
      url: '/pipeline/memberships',
      headers: { 'x-internal-api-key': API_KEY },
      payload: {
        lead_id: LEAD_ID_1,
        location_id: LOCATION_ID,
        pipeline: 'in_retention',
        stage: 'recall_due',
        reason: 'manual',
        timeout_at: futureDate,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(new Date(body.timeout_at).toISOString()).toBe(new Date(futureDate).toISOString());
  });

  it('returns 401 without X-Internal-Api-Key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/pipeline/memberships',
      payload: {
        lead_id: LEAD_ID_1,
        location_id: LOCATION_ID,
        pipeline: 'new_patient',
        stage: 'new_lead',
        reason: 'manual',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  // ── Query: list ───────────────────────────────────────────

  it('GET /pipeline/memberships?lead_id filters correctly', async () => {
    // Enroll two leads
    await app.inject({
      method: 'POST',
      url: '/pipeline/memberships',
      headers: { 'x-internal-api-key': API_KEY },
      payload: { lead_id: LEAD_ID_1, location_id: LOCATION_ID, pipeline: 'new_patient', stage: 'new_lead', reason: 'manual' },
    });
    await app.inject({
      method: 'POST',
      url: '/pipeline/memberships',
      headers: { 'x-internal-api-key': API_KEY },
      payload: { lead_id: LEAD_ID_2, location_id: LOCATION_ID, pipeline: 'new_patient', stage: 'new_lead', reason: 'manual' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/pipeline/memberships?lead_id=${LEAD_ID_1}`,
      headers: { 'x-internal-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].lead_id).toBe(LEAD_ID_1);
  });

  it('GET /pipeline/memberships?status=active filters correctly', async () => {
    await app.inject({
      method: 'POST',
      url: '/pipeline/memberships',
      headers: { 'x-internal-api-key': API_KEY },
      payload: { lead_id: LEAD_ID_1, location_id: LOCATION_ID, pipeline: 'new_patient', stage: 'new_lead', reason: 'manual' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/pipeline/memberships?status=active',
      headers: { 'x-internal-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);

    const resInactive = await app.inject({
      method: 'GET',
      url: '/pipeline/memberships?status=closed',
      headers: { 'x-internal-api-key': API_KEY },
    });
    expect(resInactive.json().data).toHaveLength(0);
  });

  it('GET /pipeline/memberships?pipeline=new_patient filters correctly', async () => {
    await app.inject({
      method: 'POST',
      url: '/pipeline/memberships',
      headers: { 'x-internal-api-key': API_KEY },
      payload: { lead_id: LEAD_ID_1, location_id: LOCATION_ID, pipeline: 'new_patient', stage: 'new_lead', reason: 'manual' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/pipeline/memberships?pipeline=new_patient',
      headers: { 'x-internal-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);

    const resOther = await app.inject({
      method: 'GET',
      url: '/pipeline/memberships?pipeline=in_treatment',
      headers: { 'x-internal-api-key': API_KEY },
    });
    expect(resOther.json().data).toHaveLength(0);
  });

  // ── Query: by ID ──────────────────────────────────────────

  it('GET /pipeline/memberships/:id returns membership', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/pipeline/memberships',
      headers: { 'x-internal-api-key': API_KEY },
      payload: { lead_id: LEAD_ID_1, location_id: LOCATION_ID, pipeline: 'new_patient', stage: 'new_lead', reason: 'manual' },
    });
    const id = create.json().id;

    const res = await app.inject({
      method: 'GET',
      url: `/pipeline/memberships/${id}`,
      headers: { 'x-internal-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
  });

  it('GET /pipeline/memberships/:id returns 404 for unknown id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pipeline/memberships/00000000-0000-0000-0000-000000000099',
      headers: { 'x-internal-api-key': API_KEY },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  // ── Cursor pagination ─────────────────────────────────────

  it('cursor pagination returns correct pages', async () => {
    // Insert 3 memberships for different leads
    for (const leadId of [LEAD_ID_1, LEAD_ID_2, LEAD_ID_3]) {
      await app.inject({
        method: 'POST',
        url: '/pipeline/memberships',
        headers: { 'x-internal-api-key': API_KEY },
        payload: { lead_id: leadId, location_id: LOCATION_ID, pipeline: 'new_patient', stage: 'new_lead', reason: 'manual' },
      });
    }

    // First page: limit=2
    const page1 = await app.inject({
      method: 'GET',
      url: '/pipeline/memberships?limit=2',
      headers: { 'x-internal-api-key': API_KEY },
    });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.data).toHaveLength(2);
    expect(body1.nextCursor).toBeTruthy();

    // Second page: use cursor
    const page2 = await app.inject({
      method: 'GET',
      url: `/pipeline/memberships?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
      headers: { 'x-internal-api-key': API_KEY },
    });
    expect(page2.statusCode).toBe(200);
    const body2 = page2.json();
    expect(body2.data).toHaveLength(1);
    expect(body2.nextCursor).toBeNull();
  });
});
