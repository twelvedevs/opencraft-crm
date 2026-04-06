import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  HAS_DB,
  buildTestApp,
  runMigrations,
  cleanup,
  truncateTables,
  makeJwt,
  LOCATION_ID,
} from './helpers.js';

describe.skipIf(!HAS_DB)('tag routes (integration)', () => {
  let app: FastifyInstance;
  let agentToken: string;
  let managerToken: string;

  beforeAll(async () => {
    await runMigrations();
    app = await buildTestApp();
    await app.ready();
    agentToken = makeJwt({ role: 'call_center_agent', locations: [LOCATION_ID] });
    managerToken = makeJwt({ role: 'marketing_manager', locations: [LOCATION_ID] });
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

  async function createTag(name: string, locationId?: string): Promise<string> {
    const payload: Record<string, string> = { name };
    if (locationId) payload.location_id = locationId;

    const res = await app.inject({
      method: 'POST',
      url: '/tags',
      headers: { authorization: `Bearer ${managerToken}` },
      payload,
    });
    return res.json().id;
  }

  // ─── POST /tags ────────────────────────────────────────────

  it('creates global tag (location_id omitted), returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tags',
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { name: 'VIP' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBe('VIP');
    expect(body.location_id).toBeNull();
  });

  it('same name again returns 409', async () => {
    await app.inject({
      method: 'POST',
      url: '/tags',
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { name: 'VIP' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/tags',
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { name: 'VIP' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('tag name already exists');
  });

  it('creates location-scoped tag', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tags',
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { name: 'Local Tag', location_id: LOCATION_ID },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().location_id).toBe(LOCATION_ID);
  });

  // ─── GET /tags ─────────────────────────────────────────────

  it('GET /tags?location_id returns location + global tags', async () => {
    // Create a global tag and a location-scoped tag
    await createTag('GlobalTag');
    await createTag('LocalTag', LOCATION_ID);

    const res = await app.inject({
      method: 'GET',
      url: `/tags?location_id=${LOCATION_ID}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2);
    const names = body.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['GlobalTag', 'LocalTag']);
  });

  // ─── POST /leads/:id/tags ─────────────────────────────────

  it('applies tag to lead', async () => {
    const leadId = await createLead();
    const tagId = await createTag('Important');

    const res = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/tags`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { tag_id: tagId },
    });

    expect(res.statusCode).toBe(200);

    // Verify via GET /leads/:id — tags should be populated
    const leadRes = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(leadRes.statusCode).toBe(200);
    const lead = leadRes.json();
    expect(lead.tags).toHaveLength(1);
    expect(lead.tags[0].name).toBe('Important');
  });

  // ─── DELETE /leads/:id/tags/:tag_id ────────────────────────

  it('removes tag from lead', async () => {
    const leadId = await createLead();
    const tagId = await createTag('Removable');

    // Apply tag first
    await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/tags`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { tag_id: tagId },
    });

    // Remove it
    const res = await app.inject({
      method: 'DELETE',
      url: `/leads/${leadId}/tags/${tagId}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(res.statusCode).toBe(204);

    // Verify tag is gone from lead
    const leadRes = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(leadRes.json().tags).toHaveLength(0);
  });

  // ─── DELETE /tags/:id ──────────────────────────────────────

  it('removes tag from system', async () => {
    const tagId = await createTag('ToDelete');

    const res = await app.inject({
      method: 'DELETE',
      url: `/tags/${tagId}`,
      headers: { authorization: `Bearer ${managerToken}` },
    });

    expect(res.statusCode).toBe(204);

    // Verify tag is gone
    const listRes = await app.inject({
      method: 'GET',
      url: '/tags',
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(listRes.json()).toHaveLength(0);
  });
});
