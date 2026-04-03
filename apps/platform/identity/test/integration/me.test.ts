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

describe.skipIf(!process.env['DATABASE_URL'])('me routes integration', () => {
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

  it('GET /identity/me with valid JWT returns 200 profile', async () => {
    const user = await insertTestUser(pool, { role: 'marketing_manager' });

    // Add a location
    await pool.query(
      'INSERT INTO platform_identity.user_locations (user_id, location_id) VALUES ($1, $2)',
      [user.id, '00000000-0000-0000-0000-000000000001'],
    );

    const token = signAccessToken({
      sub: user.id,
      role: 'marketing_manager',
      locations: ['00000000-0000-0000-0000-000000000001'],
      must_change_password: false,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/identity/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(user.id);
    expect(body.email).toBe(user.email);
    expect(body.name).toBe(user.name);
    expect(body.role).toBe('marketing_manager');
    expect(body.locations).toEqual(['00000000-0000-0000-0000-000000000001']);
    expect(body.status).toBe('active');
  });

  it('PUT /identity/me/password with must_change_password=true ignores current_password and returns 200', async () => {
    const user = await insertTestUser(pool, { force_password_reset: true });

    provider.setPassword = vi.fn().mockResolvedValue(undefined);

    const token = signAccessToken({
      sub: user.id,
      role: 'super_admin',
      locations: [],
      must_change_password: true,
    });

    const res = await app.inject({
      method: 'PUT',
      url: '/identity/me/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { new_password: 'NewP@ssw0rd!' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    expect(provider.setPassword).toHaveBeenCalled();
  });

  it('PUT /identity/me/password with must_change_password=false and missing current_password returns 400', async () => {
    const user = await insertTestUser(pool);

    const token = signAccessToken({
      sub: user.id,
      role: 'super_admin',
      locations: [],
      must_change_password: false,
    });

    const res = await app.inject({
      method: 'PUT',
      url: '/identity/me/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { new_password: 'NewP@ssw0rd!' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('current_password_required');
  });

  it('GET /identity/me with must_change_password=true JWT returns 200 (not blocked)', async () => {
    const user = await insertTestUser(pool, { force_password_reset: true });

    const token = signAccessToken({
      sub: user.id,
      role: 'super_admin',
      locations: [],
      must_change_password: true,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/identity/me',
      headers: { authorization: `Bearer ${token}` },
    });

    // GET /identity/me bypasses must_change_password gate
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(user.id);
  });

  it('GET /identity/users with must_change_password=true JWT returns 403 password_change_required', async () => {
    const user = await insertTestUser(pool, { force_password_reset: true });

    const token = signAccessToken({
      sub: user.id,
      role: 'super_admin',
      locations: [],
      must_change_password: true,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/identity/users',
      headers: { authorization: `Bearer ${token}` },
    });

    // GET /identity/users IS blocked by must_change_password gate
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('password_change_required');
  });
});
