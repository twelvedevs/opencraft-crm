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
  insertCampaign,
  insertCampaignEvent,
  LOCATION_ID,
  USER_ID,
  MANAGER_ID,
} from './helpers.js';

describe.skipIf(!HAS_DB)('approval workflow (integration)', () => {
  let app: FastifyInstance;
  let staffToken: string;
  let managerToken: string;

  beforeAll(async () => {
    await runMigrations();
    app = await buildTestApp();
    await app.ready();
    staffToken = makeJwt({ sub: USER_ID, role: 'marketing_staff', locations: [LOCATION_ID] });
    managerToken = makeJwt({ sub: MANAGER_ID, role: 'marketing_manager', locations: [LOCATION_ID] });
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
  });

  const validCampaign = {
    name: 'Spring Promo',
    template_id: '00000000-0000-0000-0000-000000000100',
    subject: 'Spring Special Offer',
    segment_id: '00000000-0000-0000-0000-000000000200',
  };

  // ─── POST /campaigns ──────────────────────────────────────

  describe('POST /campaigns', () => {
    it('creates a draft campaign with campaign_events row', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/campaigns',
        headers: { authorization: `Bearer ${staffToken}` },
        payload: validCampaign,
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.campaign_id).toBeDefined();
      expect(body.status).toBe('draft');

      // Verify campaign_events row
      const db = getDb();
      const events = await db('campaign_events').where({ campaign_id: body.campaign_id });
      expect(events).toHaveLength(1);
      expect(events[0].from_status).toBeNull();
      expect(events[0].to_status).toBe('draft');
    });

    it('returns 400 when both segment_id and audience_filter provided', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/campaigns',
        headers: { authorization: `Bearer ${staffToken}` },
        payload: {
          ...validCampaign,
          audience_filter: { age: { gte: 18 } },
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when neither segment_id nor audience_filter provided', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/campaigns',
        headers: { authorization: `Bearer ${staffToken}` },
        payload: {
          name: 'No audience',
          template_id: '00000000-0000-0000-0000-000000000100',
          subject: 'Test',
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ─── GET /campaigns ───────────────────────────────────────

  describe('GET /campaigns', () => {
    it('returns items array and total', async () => {
      const db = getDb();
      await insertCampaign(db);
      await insertCampaign(db, { name: 'Second Campaign' });

      const res = await app.inject({
        method: 'GET',
        url: '/campaigns',
        headers: { authorization: `Bearer ${staffToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it('filters by status', async () => {
      const db = getDb();
      await insertCampaign(db, { name: 'Draft', status: 'draft' });
      await insertCampaign(db, { name: 'Approved', status: 'approved' });

      const res = await app.inject({
        method: 'GET',
        url: '/campaigns?status=draft',
        headers: { authorization: `Bearer ${staffToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].name).toBe('Draft');
      expect(body.total).toBe(1);
    });
  });

  // ─── GET /campaigns/:id ───────────────────────────────────

  describe('GET /campaigns/:id', () => {
    it('returns full campaign for valid id', async () => {
      const db = getDb();
      const campaign = await insertCampaign(db);

      const res = await app.inject({
        method: 'GET',
        url: `/campaigns/${campaign.id}`,
        headers: { authorization: `Bearer ${staffToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(campaign.id);
      expect(body.name).toBe('Test Campaign');
    });

    it('returns 404 for unknown id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/campaigns/00000000-0000-0000-0000-999999999999',
        headers: { authorization: `Bearer ${staffToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ─── PATCH /campaigns/:id ─────────────────────────────────

  describe('PATCH /campaigns/:id', () => {
    it('updates draft campaign fields', async () => {
      const db = getDb();
      const campaign = await insertCampaign(db);

      const res = await app.inject({
        method: 'PATCH',
        url: `/campaigns/${campaign.id}`,
        headers: { authorization: `Bearer ${staffToken}` },
        payload: { name: 'Updated Name', subject: 'New Subject' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.campaign_id).toBe(campaign.id);
      expect(body.status).toBe('draft');
    });

    it('returns 409 when patching content field on approved campaign', async () => {
      const db = getDb();
      const campaign = await insertCampaign(db, { status: 'approved' });

      const res = await app.inject({
        method: 'PATCH',
        url: `/campaigns/${campaign.id}`,
        headers: { authorization: `Bearer ${staffToken}` },
        payload: { template_id: '00000000-0000-0000-0000-000000000999' },
      });

      expect(res.statusCode).toBe(409);
    });

    it('allows updating scheduled_for on approved campaign', async () => {
      const db = getDb();
      const campaign = await insertCampaign(db, { status: 'approved' });

      const res = await app.inject({
        method: 'PATCH',
        url: `/campaigns/${campaign.id}`,
        headers: { authorization: `Bearer ${staffToken}` },
        payload: { scheduled_for: '2026-05-01T10:00:00Z' },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // ─── DELETE /campaigns/:id ────────────────────────────────

  describe('DELETE /campaigns/:id', () => {
    it('deletes a draft campaign', async () => {
      const db = getDb();
      const campaign = await insertCampaign(db);

      const res = await app.inject({
        method: 'DELETE',
        url: `/campaigns/${campaign.id}`,
        headers: { authorization: `Bearer ${staffToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.deleted).toBe(true);
    });

    it('returns 409 for non-draft campaign', async () => {
      const db = getDb();
      const campaign = await insertCampaign(db, { status: 'pending_review' });

      const res = await app.inject({
        method: 'DELETE',
        url: `/campaigns/${campaign.id}`,
        headers: { authorization: `Bearer ${staffToken}` },
      });

      expect(res.statusCode).toBe(409);
    });
  });

  // ─── POST /campaigns/:id/submit ──────────────────────────

  describe('POST /campaigns/:id/submit', () => {
    it('transitions draft to pending_review', async () => {
      const db = getDb();
      const campaign = await insertCampaign(db);

      const res = await app.inject({
        method: 'POST',
        url: `/campaigns/${campaign.id}/submit`,
        headers: { authorization: `Bearer ${staffToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('pending_review');

      // Verify event written
      const events = await db('campaign_events').where({ campaign_id: campaign.id as string });
      const submitEvent = events.find((e: Record<string, unknown>) => e.to_status === 'pending_review');
      expect(submitEvent).toBeDefined();
      expect(submitEvent.from_status).toBe('draft');
    });

    it('returns 409 on second submit', async () => {
      const db = getDb();
      const campaign = await insertCampaign(db, { status: 'pending_review' });

      const res = await app.inject({
        method: 'POST',
        url: `/campaigns/${campaign.id}/submit`,
        headers: { authorization: `Bearer ${staffToken}` },
      });

      expect(res.statusCode).toBe(409);
    });
  });

  // ─── POST /campaigns/:id/approve ─────────────────────────

  describe('POST /campaigns/:id/approve', () => {
    it('marketing_manager can approve pending_review campaign', async () => {
      const db = getDb();
      const campaign = await insertCampaign(db, { status: 'pending_review' });

      const res = await app.inject({
        method: 'POST',
        url: `/campaigns/${campaign.id}/approve`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('approved');

      // Verify approved_by is set
      const updated = await db('campaigns').where({ id: campaign.id }).first();
      expect(updated.approved_by).toBe(MANAGER_ID);
      expect(updated.approved_at).not.toBeNull();

      // Verify campaign_events row
      const events = await db('campaign_events').where({ campaign_id: campaign.id as string });
      const approveEvent = events.find((e: Record<string, unknown>) => e.to_status === 'approved');
      expect(approveEvent).toBeDefined();
    });

    it('marketing_staff gets 403', async () => {
      const db = getDb();
      const campaign = await insertCampaign(db, { status: 'pending_review' });

      const res = await app.inject({
        method: 'POST',
        url: `/campaigns/${campaign.id}/approve`,
        headers: { authorization: `Bearer ${staffToken}` },
        payload: {},
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ─── POST /campaigns/:id/reject ──────────────────────────

  describe('POST /campaigns/:id/reject', () => {
    it('returns 400 when comment is missing', async () => {
      const db = getDb();
      const campaign = await insertCampaign(db, { status: 'pending_review' });

      const res = await app.inject({
        method: 'POST',
        url: `/campaigns/${campaign.id}/reject`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { comment: '' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects with comment and returns to draft', async () => {
      const db = getDb();
      const campaign = await insertCampaign(db, { status: 'pending_review' });

      const res = await app.inject({
        method: 'POST',
        url: `/campaigns/${campaign.id}/reject`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { comment: 'Needs better subject line' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('draft');

      // Verify campaign_comments row written
      const comments = await db('campaign_comments').where({ campaign_id: campaign.id as string });
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toBe('Needs better subject line');
      expect(comments[0].author_id).toBe(MANAGER_ID);
    });
  });

  // ─── POST /campaigns/:id/cancel ──────────────────────────

  describe('POST /campaigns/:id/cancel', () => {
    it('cancels from draft', async () => {
      const db = getDb();
      const campaign = await insertCampaign(db);

      const res = await app.inject({
        method: 'POST',
        url: `/campaigns/${campaign.id}/cancel`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('cancelled');
    });

    it('cancels from pending_review without reject', async () => {
      const db = getDb();
      const campaign = await insertCampaign(db, { status: 'pending_review' });

      const res = await app.inject({
        method: 'POST',
        url: `/campaigns/${campaign.id}/cancel`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('cancelled');
    });

    it('returns 409 from sending status', async () => {
      const db = getDb();
      const campaign = await insertCampaign(db, { status: 'sending' });

      const res = await app.inject({
        method: 'POST',
        url: `/campaigns/${campaign.id}/cancel`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {},
      });

      expect(res.statusCode).toBe(409);
    });
  });

  // ─── Comments ─────────────────────────────────────────────

  describe('POST & GET /campaigns/:id/comments', () => {
    it('creates and lists comments', async () => {
      const db = getDb();
      const campaign = await insertCampaign(db);

      // POST comment
      const postRes = await app.inject({
        method: 'POST',
        url: `/campaigns/${campaign.id}/comments`,
        headers: { authorization: `Bearer ${staffToken}` },
        payload: { body: 'Looks good to me' },
      });

      expect(postRes.statusCode).toBe(201);
      const postBody = postRes.json();
      expect(postBody.comment_id).toBeDefined();
      expect(postBody.author_id).toBe(USER_ID);
      expect(postBody.body).toBe('Looks good to me');
      expect(postBody.created_at).toBeDefined();

      // GET comments
      const getRes = await app.inject({
        method: 'GET',
        url: `/campaigns/${campaign.id}/comments`,
        headers: { authorization: `Bearer ${staffToken}` },
      });

      expect(getRes.statusCode).toBe(200);
      const getBody = getRes.json();
      expect(getBody.comments).toHaveLength(1);
      expect(getBody.total).toBe(1);
      expect(getBody.comments[0].body).toBe('Looks good to me');
    });

    it('returns 404 for comments on unknown campaign', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/campaigns/00000000-0000-0000-0000-999999999999/comments',
        headers: { authorization: `Bearer ${staffToken}` },
        payload: { body: 'Hello' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ─── Full workflow end-to-end ─────────────────────────────

  describe('full approval workflow', () => {
    it('create → submit → approve → verify events', async () => {
      // Create
      const createRes = await app.inject({
        method: 'POST',
        url: '/campaigns',
        headers: { authorization: `Bearer ${staffToken}` },
        payload: validCampaign,
      });
      expect(createRes.statusCode).toBe(201);
      const campaignId = createRes.json().campaign_id;

      // Submit
      const submitRes = await app.inject({
        method: 'POST',
        url: `/campaigns/${campaignId}/submit`,
        headers: { authorization: `Bearer ${staffToken}` },
      });
      expect(submitRes.statusCode).toBe(200);
      expect(submitRes.json().status).toBe('pending_review');

      // Approve
      const approveRes = await app.inject({
        method: 'POST',
        url: `/campaigns/${campaignId}/approve`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { comment: 'Approved, ship it!' },
      });
      expect(approveRes.statusCode).toBe(200);
      expect(approveRes.json().status).toBe('approved');

      // Verify full event trail
      const db = getDb();
      const events = await db('campaign_events')
        .where({ campaign_id: campaignId })
        .orderBy('created_at', 'asc');
      expect(events).toHaveLength(3);
      expect(events[0].to_status).toBe('draft');
      expect(events[1].to_status).toBe('pending_review');
      expect(events[2].to_status).toBe('approved');
    });

    it('create → submit → reject → resubmit → approve', async () => {
      // Create
      const createRes = await app.inject({
        method: 'POST',
        url: '/campaigns',
        headers: { authorization: `Bearer ${staffToken}` },
        payload: validCampaign,
      });
      const campaignId = createRes.json().campaign_id;

      // Submit
      await app.inject({
        method: 'POST',
        url: `/campaigns/${campaignId}/submit`,
        headers: { authorization: `Bearer ${staffToken}` },
      });

      // Reject
      const rejectRes = await app.inject({
        method: 'POST',
        url: `/campaigns/${campaignId}/reject`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: { comment: 'Fix the subject line' },
      });
      expect(rejectRes.statusCode).toBe(200);
      expect(rejectRes.json().status).toBe('draft');

      // Re-submit
      const resubmitRes = await app.inject({
        method: 'POST',
        url: `/campaigns/${campaignId}/submit`,
        headers: { authorization: `Bearer ${staffToken}` },
      });
      expect(resubmitRes.statusCode).toBe(200);

      // Approve
      const approveRes = await app.inject({
        method: 'POST',
        url: `/campaigns/${campaignId}/approve`,
        headers: { authorization: `Bearer ${managerToken}` },
        payload: {},
      });
      expect(approveRes.statusCode).toBe(200);
      expect(approveRes.json().status).toBe('approved');
    });
  });
});
