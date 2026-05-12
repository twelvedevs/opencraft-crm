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

describe.skipIf(!HAS_DB)('activity routes (integration)', () => {
  let app: FastifyInstance;
  let agentToken: string;

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

  async function insertActivity(leadId: string, eventType: string, occurredAt: string, sourceEventId: string): Promise<void> {
    const db = getDb();
    await db('crm_leads.lead_activities').insert({
      lead_id: leadId,
      event_type: eventType,
      actor_type: 'system',
      actor_id: null,
      payload: JSON.stringify({}),
      occurred_at: occurredAt,
      source_event_id: sourceEventId,
    });
  }

  // ─── GET /leads/:id/activities ─────────────────────────────

  it('returns empty array for fresh lead', async () => {
    const leadId = await createLead();

    const res = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}/activities`,
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it('returns activity after manual insert, ordered occurred_at DESC', async () => {
    const leadId = await createLead();

    await insertActivity(leadId, 'lead_created', '2026-04-01T10:00:00Z', 'evt-1');
    await insertActivity(leadId, 'stage_changed', '2026-04-02T10:00:00Z', 'evt-2');

    const res = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}/activities`,
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(2);
    // Most recent first
    expect(body.data[0].event_type).toBe('stage_changed');
    expect(body.data[1].event_type).toBe('lead_created');
  });

  it('event_type filter returns only matching events', async () => {
    const leadId = await createLead();

    await insertActivity(leadId, 'lead_created', '2026-04-01T10:00:00Z', 'evt-1');
    await insertActivity(leadId, 'stage_changed', '2026-04-02T10:00:00Z', 'evt-2');
    await insertActivity(leadId, 'note_added', '2026-04-03T10:00:00Z', 'evt-3');

    const res = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}/activities?event_type=stage_changed`,
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].event_type).toBe('stage_changed');
  });

  it('cursor pagination returns second page correctly', async () => {
    const leadId = await createLead();

    // Insert 3 activities
    await insertActivity(leadId, 'evt_a', '2026-04-01T10:00:00Z', 'evt-1');
    await insertActivity(leadId, 'evt_b', '2026-04-02T10:00:00Z', 'evt-2');
    await insertActivity(leadId, 'evt_c', '2026-04-03T10:00:00Z', 'evt-3');

    // Page 1 with limit=2
    const page1 = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}/activities?limit=2`,
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.data).toHaveLength(2);
    expect(body1.nextCursor).not.toBeNull();

    // Page 2
    const page2 = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}/activities?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(page2.statusCode).toBe(200);
    const body2 = page2.json();
    expect(body2.data).toHaveLength(1);
    expect(body2.nextCursor).toBeNull();
  });

  it('returns 404 for unknown lead_id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/leads/00000000-0000-0000-0000-000000000099/activities',
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(res.statusCode).toBe(404);
  });
});
