import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import {
  setTestEnv,
  mockJwksFetch,
  createSchema,
  truncateTables,
  createMockProvider,
  insertTestUser,
} from './helpers.js';

// Set env and mock JWKS fetch before any app imports
setTestEnv();
mockJwksFetch();

import type { FastifyInstance } from 'fastify';
import type { AuthProvider } from '../../src/providers/auth-provider.interface.js';

let pool: pg.Pool;
let app: FastifyInstance;
let provider: AuthProvider;
let signAccessToken: typeof import('../../src/services/token.service.js').signAccessToken;

function adminToken(userId: string) {
  return signAccessToken({
    sub: userId,
    role: 'super_admin',
    locations: [],
    must_change_password: false,
  });
}

describe.skipIf(!process.env['DATABASE_URL'])('users routes integration', () => {
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
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('POST /identity/users creates user and returns 201 with force_password_reset=true', async () => {
    // Need an admin user to authenticate as
    const admin = await insertTestUser(pool, {
      email: 'admin@example.com',
      provider_user_id: 'provider-admin',
    });

    provider.createUser = vi.fn().mockResolvedValue({ providerUserId: 'provider-new-user' });

    const token = adminToken(admin.id);

    const res = await app.inject({
      method: 'POST',
      url: '/identity/users',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        email: 'newuser@example.com',
        name: 'New User',
        role: 'call_center_agent',
        password: 'Str0ng!Pass',
        locations: ['00000000-0000-0000-0000-000000000001'],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.email).toBe('newuser@example.com');
    expect(body.name).toBe('New User');
    expect(body.role).toBe('call_center_agent');
    expect(body.force_password_reset).toBe(true);
    expect(body.status).toBe('active');
    expect(body.locations).toEqual(['00000000-0000-0000-0000-000000000001']);
  });

  it('GET /identity/users cursor pagination round-trip', async () => {
    const admin = await insertTestUser(pool, {
      email: 'admin@example.com',
      provider_user_id: 'provider-admin',
    });

    // Insert 3 more users (admin is already 1)
    for (let i = 1; i <= 3; i++) {
      await insertTestUser(pool, {
        email: `user${i}@example.com`,
        provider_user_id: `provider-user-${i}`,
        role: 'call_center_agent',
      });
    }

    const token = adminToken(admin.id);

    // First page — limit=2
    const page1Res = await app.inject({
      method: 'GET',
      url: '/identity/users?limit=2',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(page1Res.statusCode).toBe(200);
    const page1 = page1Res.json();
    expect(page1.users).toHaveLength(2);
    expect(page1.next_cursor).toBeTruthy();

    // Second page using cursor
    const page2Res = await app.inject({
      method: 'GET',
      url: `/identity/users?limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(page2Res.statusCode).toBe(200);
    const page2 = page2Res.json();
    expect(page2.users).toHaveLength(2);

    // All 4 IDs should be unique
    const allIds = [...page1.users.map((u: { id: string }) => u.id), ...page2.users.map((u: { id: string }) => u.id)];
    expect(new Set(allIds).size).toBe(4);
  });

  it('PUT /identity/users/:id status=inactive triggers deactivation', async () => {
    const admin = await insertTestUser(pool, {
      email: 'admin@example.com',
      provider_user_id: 'provider-admin',
    });

    const target = await insertTestUser(pool, {
      email: 'target@example.com',
      provider_user_id: 'provider-target',
      role: 'call_center_agent',
    });

    provider.deactivateUser = vi.fn().mockResolvedValue(undefined);
    const token = adminToken(admin.id);

    const res = await app.inject({
      method: 'PUT',
      url: `/identity/users/${target.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'inactive' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('inactive');
    expect(provider.deactivateUser).toHaveBeenCalledWith(target.provider_user_id);
  });

  it('PUT /identity/users/:id status=active on inactive user returns 422', async () => {
    const admin = await insertTestUser(pool, {
      email: 'admin@example.com',
      provider_user_id: 'provider-admin',
    });

    const target = await insertTestUser(pool, {
      email: 'target@example.com',
      provider_user_id: 'provider-target',
      role: 'call_center_agent',
      status: 'inactive',
    });

    const token = adminToken(admin.id);

    const res = await app.inject({
      method: 'PUT',
      url: `/identity/users/${target.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'active' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('reactivation_not_supported');
  });

  it('POST /identity/users with weak password returns 400 with details', async () => {
    const admin = await insertTestUser(pool, {
      email: 'admin@example.com',
      provider_user_id: 'provider-admin',
    });

    const token = adminToken(admin.id);

    const res = await app.inject({
      method: 'POST',
      url: '/identity/users',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        email: 'weak@example.com',
        name: 'Weak User',
        role: 'call_center_agent',
        password: 'short',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('password_policy_violation');
    expect(body.details).toBeInstanceOf(Array);
    expect(body.details.length).toBeGreaterThan(0);
  });
});
