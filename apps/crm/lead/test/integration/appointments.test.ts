import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  HAS_DB,
  buildTestApp,
  runMigrations,
  cleanup,
  truncateTables,
  makeJwt,
  getDb,
  LOCATION_ID,
} from './helpers.js';

describe.skipIf(!HAS_DB)('appointment routes (integration)', () => {
  let app: FastifyInstance;
  let agentToken: string;

  const SERVICE_TOKEN = 'test-service-token-12345';

  beforeAll(async () => {
    await runMigrations();
    app = await buildTestApp();
    await app.ready();
    agentToken = makeJwt({ role: 'call_center_agent', locations: [LOCATION_ID] });
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
  });

  const validLead = {
    first_name: 'John',
    last_name: 'Doe',
    phone: '2125551234',
    channel: 'website_form',
    location_id: LOCATION_ID,
  };

  async function createLead(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/leads',
      headers: { authorization: `Bearer ${agentToken}` },
      payload: validLead,
    });
    return res.json().id;
  }

  // ─── POST /leads/:id/appointments ──────────────────────────

  it('creates appointment with status scheduled, returns 201', async () => {
    const leadId = await createLead();

    const res = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/appointments`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        appointment_type: 'exam',
        scheduled_at: '2026-05-01T10:00:00Z',
        notes: 'First exam',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.status).toBe('scheduled');
    expect(body.appointment_type).toBe('exam');
    expect(body.lead_id).toBe(leadId);
  });

  it('returns 404 when lead does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/leads/00000000-0000-0000-0000-000000000099/appointments',
      headers: { authorization: `Bearer ${agentToken}` },
      payload: {
        appointment_type: 'exam',
        scheduled_at: '2026-05-01T10:00:00Z',
      },
    });

    expect(res.statusCode).toBe(404);
  });

  // ─── PATCH /leads/:id/appointments/:appt_id ───────────────

  it('updates status to completed, returns 200', async () => {
    const leadId = await createLead();

    const create = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/appointments`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { appointment_type: 'exam', scheduled_at: '2026-05-01T10:00:00Z' },
    });
    const apptId = create.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/leads/${leadId}/appointments/${apptId}`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { status: 'completed' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('completed');
  });

  // ─── DELETE /leads/:id/appointments/:appt_id ──────────────

  it('DELETE with valid SERVICE_AUTH_TOKEN returns 204', async () => {
    const leadId = await createLead();

    const create = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/appointments`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { appointment_type: 'follow_up', scheduled_at: '2026-06-01T10:00:00Z' },
    });
    const apptId = create.json().id;

    const res = await app.inject({
      method: 'DELETE',
      url: `/leads/${leadId}/appointments/${apptId}`,
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
    });

    expect(res.statusCode).toBe(204);
  });

  it('DELETE without token returns 401', async () => {
    const leadId = await createLead();

    const create = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/appointments`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { appointment_type: 'exam', scheduled_at: '2026-06-01T10:00:00Z' },
    });
    const apptId = create.json().id;

    const res = await app.inject({
      method: 'DELETE',
      url: `/leads/${leadId}/appointments/${apptId}`,
    });

    expect(res.statusCode).toBe(401);
  });

  // ─── GET /leads/:id/appointments ───────────────────────────

  it('GET returns 404 when lead does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/leads/00000000-0000-0000-0000-000000000099/appointments',
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(res.statusCode).toBe(404);
  });

  it('GET returns array including the created appointment', async () => {
    const leadId = await createLead();

    await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/appointments`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { appointment_type: 'exam', scheduled_at: '2026-05-01T10:00:00Z' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}/appointments`,
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].appointment_type).toBe('exam');
  });
});
