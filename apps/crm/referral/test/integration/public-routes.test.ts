import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import {
  HAS_DB,
  runMigrations,
  cleanup,
  truncateTables,
  getDb,
  buildTestApp,
  insertReferrer,
  insertReferralLink,
  insertReferral,
  LOCATION_ID,
} from './helpers.js';

describe.skipIf(!HAS_DB)('Public Routes (integration)', () => {
  let app: FastifyInstance;
  let db: Knex;

  beforeAll(async () => {
    db = getDb();
    await runMigrations();
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
  });

  // ─── GET /referrals/r/:code ────────────────────────────────

  describe('GET /referrals/r/:code', () => {
    it('active code: 302 redirect with ?ref= and click_count incremented', async () => {
      const referrer = await insertReferrer(db);
      const link = await insertReferralLink(db, {
        referrer_id: referrer.id as string,
        code: 'ACTIVE01',
        redirect_url: 'https://example.com/landing',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/referrals/r/ACTIVE01',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('https://example.com/landing?ref=ACTIVE01');

      // Wait for fire-and-forget click increment
      await new Promise((r) => setTimeout(r, 150));
      const updated = await db('referral_links').where({ id: link.id }).first();
      expect(updated.click_count).toBe(1);
    });

    it('inactive code: 302 redirect without ?ref= and no click increment', async () => {
      const referrer = await insertReferrer(db);
      const link = await insertReferralLink(db, {
        referrer_id: referrer.id as string,
        code: 'INACTV01',
        redirect_url: 'https://example.com/landing',
        status: 'inactive',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/referrals/r/INACTV01',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('https://example.com/landing');

      await new Promise((r) => setTimeout(r, 50));
      const updated = await db('referral_links').where({ id: link.id }).first();
      expect(updated.click_count).toBe(0);
    });

    it('unknown code: 404', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/referrals/r/UNKNOWN1',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ─── GET /referrals/links/:code ────────────────────────────

  describe('GET /referrals/links/:code', () => {
    it('200 with referrer_id, referral_link_id, referrer_type, referrer_name', async () => {
      const referrer = await insertReferrer(db, {
        name: 'Dr. Resolve',
        referrer_type: 'doctor',
      });
      const link = await insertReferralLink(db, {
        referrer_id: referrer.id as string,
        code: 'RESOLV01',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/referrals/links/RESOLV01',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.referrer_id).toBe(referrer.id);
      expect(body.referral_link_id).toBe(link.id);
      expect(body.referrer_type).toBe('doctor');
      expect(body.referrer_name).toBe('Dr. Resolve');
    });

    it('404 for inactive code', async () => {
      const referrer = await insertReferrer(db);
      await insertReferralLink(db, {
        referrer_id: referrer.id as string,
        code: 'INACTV02',
        status: 'inactive',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/referrals/links/INACTV02',
      });

      expect(res.statusCode).toBe(404);
    });

    it('404 for unknown code', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/referrals/links/UNKNOWN2',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ─── GET /referrals/portal/:token ──────────────────────────

  describe('GET /referrals/portal/:token', () => {
    it('200 with referrer, stats computed correctly, referrals without lead_id', async () => {
      const referrer = await insertReferrer(db, {
        referrer_type: 'doctor',
        name: 'Dr. Portal',
        practice_name: 'Portal Practice',
      });
      const link = await insertReferralLink(db, {
        referrer_id: referrer.id as string,
      });

      // 3 referrals: pending, exam_scheduled, converted
      await insertReferral(db, {
        referrer_id: referrer.id as string,
        referral_link_id: link.id as string,
        lead_id: 'lead-portal-1',
        status: 'pending',
      });
      await insertReferral(db, {
        referrer_id: referrer.id as string,
        referral_link_id: link.id as string,
        lead_id: 'lead-portal-2',
        status: 'exam_scheduled',
        exam_scheduled_at: '2026-01-15T10:00:00Z',
      });
      await insertReferral(db, {
        referrer_id: referrer.id as string,
        referral_link_id: link.id as string,
        lead_id: 'lead-portal-3',
        status: 'converted',
        exam_scheduled_at: '2026-01-10T10:00:00Z',
        converted_at: '2026-02-01T10:00:00Z',
      });

      // Create portal token
      const [portalToken] = await db('portal_tokens')
        .insert({ referrer_id: referrer.id, created_by: 'test-user-1' })
        .returning('*');

      const res = await app.inject({
        method: 'GET',
        url: `/referrals/portal/${portalToken.token}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      // Referrer fields
      expect(body.referrer.id).toBe(referrer.id);
      expect(body.referrer.name).toBe('Dr. Portal');
      expect(body.referrer.practice_name).toBe('Portal Practice');
      expect(body.referrer.location_id).toBe(LOCATION_ID);

      // Stats: exams_scheduled counts any referral with non-null exam_scheduled_at
      expect(body.stats.total_referrals).toBe(3);
      expect(body.stats.exams_scheduled).toBe(2); // exam_scheduled + converted
      expect(body.stats.cases_started).toBe(1); // only converted

      // Referrals array — no lead_id exposed
      expect(body.referrals).toHaveLength(3);
      for (const r of body.referrals) {
        expect(r).toHaveProperty('id');
        expect(r).toHaveProperty('status');
        expect(r).toHaveProperty('exam_scheduled_at');
        expect(r).toHaveProperty('converted_at');
        expect(r).not.toHaveProperty('lead_id');
      }
    });

    it('404 for unknown token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/referrals/portal/unknown-token-value',
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
