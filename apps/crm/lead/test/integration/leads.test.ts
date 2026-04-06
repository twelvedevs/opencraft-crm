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
  LOCATION_ID_2,
} from './helpers.js';

describe.skipIf(!HAS_DB)('leads routes (integration)', () => {
  let app: FastifyInstance;
  let agentToken: string;
  let managerToken: string;

  beforeAll(async () => {
    await runMigrations();
    app = await buildTestApp();
    await app.ready();
    agentToken = makeJwt({ role: 'call_center_agent', locations: [LOCATION_ID] });
    managerToken = makeJwt({ role: 'call_center_manager', locations: [LOCATION_ID] });
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

  // ─── POST /leads ───────────────────────────────────────────

  describe('POST /leads', () => {
    it('creates lead and returns 201 with score=0', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/leads',
        headers: { authorization: `Bearer ${agentToken}` },
        payload: validLead,
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.first_name).toBe('John');
      expect(body.score).toBe(0);
      expect(body.current_pipeline).toBe('none');
      expect(body.contact_status).toBe('active');
      expect(body.phone).toBe('+12125551234');
    });

    it('returns 400 for invalid phone', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/leads',
        headers: { authorization: `Bearer ${agentToken}` },
        payload: { ...validLead, phone: 'not-a-phone' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid phone number');
    });

    it('returns 400 for missing required field', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/leads',
        headers: { authorization: `Bearer ${agentToken}` },
        payload: { first_name: 'John', last_name: 'Doe' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ─── GET /leads/:id ────────────────────────────────────────

  describe('GET /leads/:id', () => {
    it('returns 200 with lead + empty tags + empty appointments', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/leads',
        headers: { authorization: `Bearer ${agentToken}` },
        payload: validLead,
      });
      const leadId = create.json().id;

      const res = await app.inject({
        method: 'GET',
        url: `/leads/${leadId}`,
        headers: { authorization: `Bearer ${agentToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(leadId);
      expect(body.tags).toEqual([]);
      expect(body.appointments).toEqual([]);
    });

    it('returns 404 for unknown id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/leads/00000000-0000-0000-0000-000000000099',
        headers: { authorization: `Bearer ${agentToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns archived lead (no 404)', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/leads',
        headers: { authorization: `Bearer ${agentToken}` },
        payload: validLead,
      });
      const leadId = create.json().id;

      // Archive it
      await app.inject({
        method: 'DELETE',
        url: `/leads/${leadId}`,
        headers: { authorization: `Bearer ${managerToken}` },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/leads/${leadId}`,
        headers: { authorization: `Bearer ${agentToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().archived_at).not.toBeNull();
    });
  });

  // ─── PATCH /leads/:id ──────────────────────────────────────

  describe('PATCH /leads/:id', () => {
    it('updates first_name and returns 200', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/leads',
        headers: { authorization: `Bearer ${agentToken}` },
        payload: validLead,
      });
      const leadId = create.json().id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/leads/${leadId}`,
        headers: { authorization: `Bearer ${agentToken}` },
        payload: { first_name: 'Jane' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().first_name).toBe('Jane');
    });

    it('normalizes phone to E.164 on update', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/leads',
        headers: { authorization: `Bearer ${agentToken}` },
        payload: validLead,
      });
      const leadId = create.json().id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/leads/${leadId}`,
        headers: { authorization: `Bearer ${agentToken}` },
        payload: { phone: '(646) 555-0100' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().phone).toBe('+16465550100');
    });

    it('returns 400 for attribution field in body', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/leads',
        headers: { authorization: `Bearer ${agentToken}` },
        payload: validLead,
      });
      const leadId = create.json().id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/leads/${leadId}`,
        headers: { authorization: `Bearer ${agentToken}` },
        payload: { channel: 'google_ads' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('attribution fields are immutable');
    });

    it('returns 403 for location_id update by non-manager', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/leads',
        headers: { authorization: `Bearer ${agentToken}` },
        payload: validLead,
      });
      const leadId = create.json().id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/leads/${leadId}`,
        headers: { authorization: `Bearer ${agentToken}` },
        payload: { location_id: LOCATION_ID_2 },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ─── DELETE /leads/:id ─────────────────────────────────────

  describe('DELETE /leads/:id', () => {
    it('manager returns 204 and sets archived_at', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/leads',
        headers: { authorization: `Bearer ${agentToken}` },
        payload: validLead,
      });
      const leadId = create.json().id;

      const res = await app.inject({
        method: 'DELETE',
        url: `/leads/${leadId}`,
        headers: { authorization: `Bearer ${managerToken}` },
      });

      expect(res.statusCode).toBe(204);

      // Verify archived_at set in DB
      const db = getDb();
      const row = await db('crm_leads.leads').where({ id: leadId }).first();
      expect(row.archived_at).not.toBeNull();
    });

    it('coordinator-role returns 403', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/leads',
        headers: { authorization: `Bearer ${agentToken}` },
        payload: validLead,
      });
      const leadId = create.json().id;

      const res = await app.inject({
        method: 'DELETE',
        url: `/leads/${leadId}`,
        headers: { authorization: `Bearer ${agentToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 404 for unknown id', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/leads/00000000-0000-0000-0000-000000000099',
        headers: { authorization: `Bearer ${managerToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ─── GET /leads (list) ─────────────────────────────────────

  describe('GET /leads', () => {
    it('returns list with correct structure { leads, nextCursor }', async () => {
      await app.inject({
        method: 'POST',
        url: '/leads',
        headers: { authorization: `Bearer ${agentToken}` },
        payload: validLead,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/leads',
        headers: { authorization: `Bearer ${agentToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('leads');
      expect(body).toHaveProperty('nextCursor');
      expect(body.leads).toHaveLength(1);
    });

    it('location_id filter returns only matching leads', async () => {
      const tokenLoc2 = makeJwt({ role: 'call_center_agent', locations: [LOCATION_ID, LOCATION_ID_2] });

      await app.inject({
        method: 'POST',
        url: '/leads',
        headers: { authorization: `Bearer ${tokenLoc2}` },
        payload: { ...validLead, location_id: LOCATION_ID },
      });
      await app.inject({
        method: 'POST',
        url: '/leads',
        headers: { authorization: `Bearer ${tokenLoc2}` },
        payload: { ...validLead, phone: '6465550100', location_id: LOCATION_ID_2 },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/leads?location_id=${LOCATION_ID}`,
        headers: { authorization: `Bearer ${tokenLoc2}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.leads).toHaveLength(1);
      expect(body.leads[0].location_id).toBe(LOCATION_ID);
    });

    it('sort=created_at returns leads in created_at DESC order', async () => {
      const token = makeJwt({ role: 'call_center_agent', locations: [LOCATION_ID] });

      await app.inject({
        method: 'POST',
        url: '/leads',
        headers: { authorization: `Bearer ${token}` },
        payload: { ...validLead, first_name: 'Alpha' },
      });
      // Small delay to ensure different created_at
      await new Promise((r) => setTimeout(r, 50));
      await app.inject({
        method: 'POST',
        url: '/leads',
        headers: { authorization: `Bearer ${token}` },
        payload: { ...validLead, first_name: 'Beta', phone: '6465550100' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/leads?sort=created_at',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.leads).toHaveLength(2);
      expect(body.leads[0].first_name).toBe('Beta');
      expect(body.leads[1].first_name).toBe('Alpha');
    });

    it('cursor pagination returns next page', async () => {
      const token = makeJwt({ role: 'call_center_agent', locations: [LOCATION_ID] });

      // Create 3 leads
      for (let i = 0; i < 3; i++) {
        await app.inject({
          method: 'POST',
          url: '/leads',
          headers: { authorization: `Bearer ${token}` },
          payload: { ...validLead, first_name: `Lead${i}`, phone: `212555${String(1000 + i)}` },
        });
      }

      const page1 = await app.inject({
        method: 'GET',
        url: '/leads?sort=created_at&limit=2',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(page1.statusCode).toBe(200);
      const body1 = page1.json();
      expect(body1.leads).toHaveLength(2);
      expect(body1.nextCursor).not.toBeNull();

      const page2 = await app.inject({
        method: 'GET',
        url: `/leads?sort=created_at&limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(page2.statusCode).toBe(200);
      const body2 = page2.json();
      expect(body2.leads).toHaveLength(1);
      expect(body2.nextCursor).toBeNull();
    });

    it('q= trigram search returns matching lead', async () => {
      const token = makeJwt({ role: 'call_center_agent', locations: [LOCATION_ID] });

      await app.inject({
        method: 'POST',
        url: '/leads',
        headers: { authorization: `Bearer ${token}` },
        payload: { ...validLead, first_name: 'Zachary', last_name: 'Thompson' },
      });
      await app.inject({
        method: 'POST',
        url: '/leads',
        headers: { authorization: `Bearer ${token}` },
        payload: { ...validLead, first_name: 'Alice', last_name: 'Johnson', phone: '6465550100' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/leads?q=Zachary',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.leads.length).toBeGreaterThanOrEqual(1);
      expect(body.leads.some((l: { first_name: string }) => l.first_name === 'Zachary')).toBe(true);
    });

    it('phones[] bulk lookup returns matching leads', async () => {
      const token = makeJwt({ role: 'call_center_agent', locations: [LOCATION_ID] });

      await app.inject({
        method: 'POST',
        url: '/leads',
        headers: { authorization: `Bearer ${token}` },
        payload: validLead,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/leads?phones=+12125551234',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.leads).toHaveLength(1);
    });

    it('emails[] bulk lookup returns matching leads', async () => {
      const token = makeJwt({ role: 'call_center_agent', locations: [LOCATION_ID] });

      await app.inject({
        method: 'POST',
        url: '/leads',
        headers: { authorization: `Bearer ${token}` },
        payload: { ...validLead, email: 'john@example.com' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/leads?emails=john@example.com',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.leads).toHaveLength(1);
    });

    it('ids[] bulk lookup returns matching leads', async () => {
      const token = makeJwt({ role: 'call_center_agent', locations: [LOCATION_ID] });

      const create = await app.inject({
        method: 'POST',
        url: '/leads',
        headers: { authorization: `Bearer ${token}` },
        payload: validLead,
      });
      const leadId = create.json().id;

      const res = await app.inject({
        method: 'GET',
        url: `/leads?ids=${leadId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.leads).toHaveLength(1);
      expect(body.leads[0].id).toBe(leadId);
    });

    it('phones[] with 101 items returns 400', async () => {
      const phones = Array.from({ length: 101 }, (_, i) => `+1212555${String(1000 + i)}`);

      const res = await app.inject({
        method: 'GET',
        url: `/leads?${phones.map((p) => `phones=${p}`).join('&')}`,
        headers: { authorization: `Bearer ${agentToken}` },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('bulk lookup limit exceeded');
    });
  });
});
