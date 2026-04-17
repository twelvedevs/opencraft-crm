import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import {
  setTestEnv,
  mockJwksFetch,
  warnIfSkipped,
  createSchema,
  truncateTables,
  createMockProvider,
  insertTestUser,
  insertTestLocation,
} from './helpers.js';

warnIfSkipped();
setTestEnv();
mockJwksFetch();

import type { FastifyInstance } from 'fastify';
import type { AuthProvider } from '../../src/providers/auth-provider.interface.js';

let pool: pg.Pool;
let app: FastifyInstance;
let provider: AuthProvider;
let signAccessToken: typeof import('../../src/services/token.service.js').signAccessToken;

function adminToken(userId: string) {
  return signAccessToken({ sub: userId, role: 'super_admin', locations: [], must_change_password: false });
}

function agentToken(userId: string) {
  return signAccessToken({ sub: userId, role: 'call_center_agent', locations: [], must_change_password: false });
}

describe.skipIf(!process.env['DATABASE_URL'])('locations routes integration', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
    await createSchema(pool);
    provider = createMockProvider();
    const { buildApp } = await import('../../src/app.js');
    const tokenService = await import('../../src/services/token.service.js');
    signAccessToken = tokenService.signAccessToken;
    app = await buildApp(pool, provider);
    await app.ready();
  });

  beforeEach(async () => {
    await truncateTables(pool);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('POST /identity/locations', () => {
    it('creates a location and returns 201', async () => {
      const admin = await insertTestUser(pool);
      const res = await app.inject({
        method: 'POST',
        url: '/identity/locations',
        headers: { authorization: `Bearer ${adminToken(admin.id)}` },
        payload: { name: 'Downtown', phone: '+15551234567', address: '1 Main St', timezone: 'America/New_York' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.name).toBe('Downtown');
      expect(body.status).toBe('active');
    });

    it('returns 403 for non-super_admin', async () => {
      const user = await insertTestUser(pool, { role: 'call_center_agent' });
      const res = await app.inject({
        method: 'POST',
        url: '/identity/locations',
        headers: { authorization: `Bearer ${agentToken(user.id)}` },
        payload: { name: 'X', phone: '+1', address: 'Y', timezone: 'UTC' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /identity/locations', () => {
    it('returns all locations', async () => {
      await insertTestLocation(pool, { name: 'Alpha' });
      await insertTestLocation(pool, { name: 'Beta', status: 'inactive' });
      const admin = await insertTestUser(pool);
      const res = await app.inject({
        method: 'GET',
        url: '/identity/locations',
        headers: { authorization: `Bearer ${adminToken(admin.id)}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().locations).toHaveLength(2);
    });

    it('filters by status', async () => {
      await insertTestLocation(pool, { name: 'Active' });
      await insertTestLocation(pool, { name: 'Inactive', status: 'inactive' });
      const admin = await insertTestUser(pool);
      const res = await app.inject({
        method: 'GET',
        url: '/identity/locations?status=active',
        headers: { authorization: `Bearer ${adminToken(admin.id)}` },
      });
      expect(res.statusCode).toBe(200);
      const locations = res.json().locations as Array<{ name: string }>;
      expect(locations).toHaveLength(1);
      expect(locations[0]!.name).toBe('Active');
    });
  });

  describe('GET /identity/locations/:id', () => {
    it('returns 200 with full location', async () => {
      const loc = await insertTestLocation(pool);
      const admin = await insertTestUser(pool);
      const res = await app.inject({
        method: 'GET',
        url: `/identity/locations/${loc.id}`,
        headers: { authorization: `Bearer ${adminToken(admin.id)}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(loc.id);
    });

    it('returns 404 for unknown id', async () => {
      const admin = await insertTestUser(pool);
      const res = await app.inject({
        method: 'GET',
        url: '/identity/locations/00000000-0000-0000-0000-000000000099',
        headers: { authorization: `Bearer ${adminToken(admin.id)}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('PATCH /identity/locations/:id', () => {
    it('updates name and returns 200', async () => {
      const loc = await insertTestLocation(pool);
      const admin = await insertTestUser(pool);
      const res = await app.inject({
        method: 'PATCH',
        url: `/identity/locations/${loc.id}`,
        headers: { authorization: `Bearer ${adminToken(admin.id)}` },
        payload: { name: 'Updated Name' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('Updated Name');
    });

    it('returns 404 for unknown id', async () => {
      const admin = await insertTestUser(pool);
      const res = await app.inject({
        method: 'PATCH',
        url: '/identity/locations/00000000-0000-0000-0000-000000000099',
        headers: { authorization: `Bearer ${adminToken(admin.id)}` },
        payload: { name: 'X' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 403 for non-super_admin', async () => {
      const loc = await insertTestLocation(pool);
      const user = await insertTestUser(pool, { role: 'call_center_agent' });
      const res = await app.inject({
        method: 'PATCH',
        url: `/identity/locations/${loc.id}`,
        headers: { authorization: `Bearer ${agentToken(user.id)}` },
        payload: { name: 'X' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('DELETE /identity/locations/:id', () => {
    it('soft-deletes and returns 204', async () => {
      const loc = await insertTestLocation(pool);
      const admin = await insertTestUser(pool);
      const res = await app.inject({
        method: 'DELETE',
        url: `/identity/locations/${loc.id}`,
        headers: { authorization: `Bearer ${adminToken(admin.id)}` },
      });
      expect(res.statusCode).toBe(204);
      // Verify status is now inactive
      const check = await pool.query('SELECT status FROM platform_identity.locations WHERE id = $1', [loc.id]);
      expect(check.rows[0].status).toBe('inactive');
    });

    it('returns 404 for unknown id', async () => {
      const admin = await insertTestUser(pool);
      const res = await app.inject({
        method: 'DELETE',
        url: '/identity/locations/00000000-0000-0000-0000-000000000099',
        headers: { authorization: `Bearer ${adminToken(admin.id)}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 409 when location has assigned users', async () => {
      const loc = await insertTestLocation(pool);
      const user = await insertTestUser(pool, { role: 'call_center_agent' });
      await pool.query(
        'INSERT INTO platform_identity.user_locations (user_id, location_id) VALUES ($1, $2)',
        [user.id, loc.id],
      );
      const admin = await insertTestUser(pool, { email: 'admin2@example.com', provider_user_id: 'p2' });
      const res = await app.inject({
        method: 'DELETE',
        url: `/identity/locations/${loc.id}`,
        headers: { authorization: `Bearer ${adminToken(admin.id)}` },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('location_has_users');
    });
  });
});
