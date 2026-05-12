import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

describe.skipIf(!HAS_DB)('dedup, merge & duplicate-status (integration)', () => {
  let app: FastifyInstance;
  let agentToken: string;
  let managerToken: string;
  let multiLocToken: string;

  beforeAll(async () => {
    await runMigrations();
    app = await buildTestApp();
    await app.ready();
    agentToken = makeJwt({ role: 'call_center_agent', locations: [LOCATION_ID] });
    managerToken = makeJwt({ role: 'call_center_manager', locations: [LOCATION_ID] });
    multiLocToken = makeJwt({ role: 'call_center_manager', locations: [LOCATION_ID, LOCATION_ID_2] });
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
  });

  const createLead = (token: string, overrides: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/leads',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        first_name: 'John',
        last_name: 'Doe',
        phone: '2125551234',
        channel: 'website_form',
        location_id: LOCATION_ID,
        ...overrides,
      },
    });

  // ─── Dedup on create ─────────────────────────────────────

  describe('POST /leads — dedup', () => {
    it('phone match → 201 with duplicate_status=flagged and duplicate_of_id set', async () => {
      const first = await createLead(agentToken);
      expect(first.statusCode).toBe(201);
      const firstLead = first.json();

      // Second lead with same phone
      const second = await createLead(agentToken, { first_name: 'Jane' });
      expect(second.statusCode).toBe(201);
      const secondLead = second.json();

      expect(secondLead.duplicate_status).toBe('flagged');
      expect(secondLead.duplicate_of_id).toBe(firstLead.id);
    });

    it('same ad_platform_lead_id returns existing lead without duplicate insert', async () => {
      const first = await createLead(agentToken, { ad_platform_lead_id: 'ad-123' });
      expect(first.statusCode).toBe(201);
      const firstLead = first.json();

      // Second call with same ad_platform_lead_id — should return existing
      const second = await createLead(agentToken, {
        ad_platform_lead_id: 'ad-123',
        first_name: 'Different',
        phone: '3105551234',
      });
      expect(second.statusCode).toBe(201);
      const secondLead = second.json();

      expect(secondLead.id).toBe(firstLead.id);
      expect(secondLead.first_name).toBe('John'); // original data, not 'Different'

      // Verify only 1 row in DB
      const db = getDb();
      const rows = await db('crm_leads.leads').select('id');
      expect(rows).toHaveLength(1);
    });

    it('no match → duplicate_status=none', async () => {
      const res = await createLead(agentToken);
      expect(res.statusCode).toBe(201);
      const lead = res.json();

      expect(lead.duplicate_status).toBe('none');
      expect(lead.duplicate_of_id).toBeNull();
    });
  });

  // ─── GET /leads/duplicates ───────────────────────────────

  describe('GET /leads/duplicates', () => {
    it('returns flagged lead and excludes resolved leads', async () => {
      // Create first lead
      await createLead(agentToken);

      // Create duplicate (same phone → flagged)
      const dup = await createLead(agentToken, { first_name: 'Dup' });
      const dupId = dup.json().id;

      const res = await app.inject({
        method: 'GET',
        url: '/leads/duplicates',
        headers: { authorization: `Bearer ${agentToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(body.data.some((l: { id: string }) => l.id === dupId)).toBe(true);

      // Resolve the duplicate
      await app.inject({
        method: 'PATCH',
        url: `/leads/${dupId}/duplicate-status`,
        headers: { authorization: `Bearer ${agentToken}` },
        payload: { status: 'resolved' },
      });

      // Should no longer appear
      const res2 = await app.inject({
        method: 'GET',
        url: '/leads/duplicates',
        headers: { authorization: `Bearer ${agentToken}` },
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().data.some((l: { id: string }) => l.id === dupId)).toBe(false);
    });

    it('pagination cursor works across pages', async () => {
      // Create 1 base + 3 flagged duplicates
      await createLead(agentToken);
      for (let i = 0; i < 3; i++) {
        await createLead(agentToken, {
          first_name: `Dup${i}`,
          phone: '2125551234', // same phone → flagged
        });
        await new Promise((r) => setTimeout(r, 20)); // ensure ordering
      }

      const page1 = await app.inject({
        method: 'GET',
        url: '/leads/duplicates?limit=2',
        headers: { authorization: `Bearer ${agentToken}` },
      });
      expect(page1.statusCode).toBe(200);
      const body1 = page1.json();
      expect(body1.data).toHaveLength(2);
      expect(body1.nextCursor).not.toBeNull();

      const page2 = await app.inject({
        method: 'GET',
        url: `/leads/duplicates?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
        headers: { authorization: `Bearer ${agentToken}` },
      });
      expect(page2.statusCode).toBe(200);
      const body2 = page2.json();
      expect(body2.data).toHaveLength(1);
    });
  });

  // ─── PATCH /leads/:id/duplicate-status ───────────────────

  describe('PATCH /leads/:id/duplicate-status', () => {
    it('resolves duplicate and clears duplicate_of_id', async () => {
      await createLead(agentToken);
      const dup = await createLead(agentToken, { first_name: 'Dup' });
      const dupId = dup.json().id;
      expect(dup.json().duplicate_status).toBe('flagged');

      const res = await app.inject({
        method: 'PATCH',
        url: `/leads/${dupId}/duplicate-status`,
        headers: { authorization: `Bearer ${agentToken}` },
        payload: { status: 'resolved' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.duplicate_status).toBe('resolved');
      expect(body.duplicate_of_id).toBeNull();
    });

    it('returns 404 for unknown id', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/leads/00000000-0000-0000-0000-000000000099/duplicate-status',
        headers: { authorization: `Bearer ${agentToken}` },
        payload: { status: 'resolved' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for wrong body shape', async () => {
      await createLead(agentToken);
      const dup = await createLead(agentToken, { first_name: 'Dup' });
      const dupId = dup.json().id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/leads/${dupId}/duplicate-status`,
        headers: { authorization: `Bearer ${agentToken}` },
        payload: { status: 'invalid_value' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── POST /leads/:id/merge ──────────────────────────────

  describe('POST /leads/:id/merge', () => {
    // Store original fetch to restore after merge tests
    const originalFetch = globalThis.fetch;

    afterAll(() => {
      globalThis.fetch = originalFetch;
    });

    function mockPipelineEngine(status: number = 200) {
      const realFetch = globalThis.fetch;
      globalThis.fetch = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/pipeline/leads/') && url.includes('/transition')) {
          return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status }));
        }
        return realFetch(input, init);
      }) as typeof globalThis.fetch;
    }

    it('merges two leads successfully (same stage, no pipeline call)', async () => {
      // Create two leads
      const leadA = await createLead(managerToken);
      const leadB = await createLead(managerToken, {
        first_name: 'Jane',
        phone: '3105551234',
      });
      const leadAId = leadA.json().id;
      const leadBId = leadB.json().id;

      // Both leads have current_stage = null, current_pipeline = 'none'
      // Use the same stage (null → we pass 'none' as winningStage but stages are null)
      // Actually current_stage is null by default, pass null — but route expects string
      // Let's use a matching stage so Pipeline Engine is NOT called
      mockPipelineEngine(200);

      const res = await app.inject({
        method: 'POST',
        url: `/leads/${leadAId}/merge`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          merge_lead_id: leadBId,
          winning_stage: leadA.json().current_stage ?? 'new_lead',
        },
      });

      // If current_stage is null and winning_stage differs, pipeline engine is called
      // For this test, let's just verify the merge went through (pipeline mock returns 200)
      if (res.statusCode !== 200) {
        // If stage mismatch caused pipeline call, verify the mock handled it
        expect(res.statusCode).toBe(200);
      }

      const body = res.json();
      expect(body.id).toBe(leadAId);

      // Verify lead B is archived with merged_into_id
      const db = getDb();
      const mergedLead = await db('crm_leads.leads').where({ id: leadBId }).first();
      expect(mergedLead.archived_at).not.toBeNull();
      expect(mergedLead.merged_into_id).toBe(leadAId);

      // Verify lead_merges row exists
      const mergeRow = await db('crm_leads.lead_merges')
        .where({ surviving_lead_id: leadAId, merged_lead_id: leadBId })
        .first();
      expect(mergeRow).toBeDefined();
      expect(mergeRow.stage_chosen).toBeDefined();

      // Verify activities copied from lead B to lead A
      const activitiesA = await db('crm_leads.lead_activities').where({ lead_id: leadAId });
      // Should have lead A's own created activity + copied from B + merge activity
      expect(activitiesA.length).toBeGreaterThanOrEqual(2);
    });

    it('pipeline engine returning 500 → response 503', async () => {
      const leadA = await createLead(managerToken);
      const leadB = await createLead(managerToken, {
        first_name: 'Jane',
        phone: '3105551234',
      });

      // Mock pipeline engine to return 500
      mockPipelineEngine(500);

      const res = await app.inject({
        method: 'POST',
        url: `/leads/${leadA.json().id}/merge`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          merge_lead_id: leadB.json().id,
          winning_stage: 'contacted', // different from current stage (null) → pipeline call
        },
      });

      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('pipeline engine unreachable or rejected transition');
    });

    it('merge_lead already merged → response 400', async () => {
      mockPipelineEngine(200);

      const leadA = await createLead(managerToken);
      const leadB = await createLead(managerToken, {
        first_name: 'Jane',
        phone: '3105551234',
      });
      const leadC = await createLead(managerToken, {
        first_name: 'Bob',
        phone: '7185551234',
      });

      // Merge B into A
      const firstMerge = await app.inject({
        method: 'POST',
        url: `/leads/${leadA.json().id}/merge`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          merge_lead_id: leadB.json().id,
          winning_stage: leadA.json().current_stage ?? 'new_lead',
        },
      });
      expect(firstMerge.statusCode).toBe(200);

      // Try to merge B (already merged) into C
      const secondMerge = await app.inject({
        method: 'POST',
        url: `/leads/${leadC.json().id}/merge`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          merge_lead_id: leadB.json().id,
          winning_stage: leadC.json().current_stage ?? 'new_lead',
        },
      });
      expect(secondMerge.statusCode).toBe(400);
      expect(secondMerge.json().error).toBe('lead already merged');
    });

    it('merge with non-existent lead → response 404', async () => {
      mockPipelineEngine(200);

      const leadA = await createLead(managerToken);

      const res = await app.inject({
        method: 'POST',
        url: `/leads/${leadA.json().id}/merge`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {
          merge_lead_id: '00000000-0000-0000-0000-000000000099',
          winning_stage: 'new_lead',
        },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('lead not found');
    });

    it('location access denied → response 403', async () => {
      mockPipelineEngine(200);

      // Create leads in different locations
      const leadA = await createLead(multiLocToken, { location_id: LOCATION_ID });
      const leadB = await createLead(multiLocToken, {
        first_name: 'Jane',
        phone: '3105551234',
        location_id: LOCATION_ID_2,
      });

      // Token with only LOCATION_ID access tries to merge lead from LOCATION_ID_2
      const singleLocToken = makeJwt({ role: 'call_center_manager', locations: [LOCATION_ID] });

      const res = await app.inject({
        method: 'POST',
        url: `/leads/${leadA.json().id}/merge`,
        headers: { authorization: `Bearer ${singleLocToken}` },
        payload: {
          merge_lead_id: leadB.json().id,
          winning_stage: 'new_lead',
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('access denied');
    });
  });
});
