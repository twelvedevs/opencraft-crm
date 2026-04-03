import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import {
  setTestEnv,
  mockJwksFetch,
  warnIfSkipped,
  createSchema,
  truncateTables,
  createMockProvider,
  insertTestUser,
} from './helpers.js';

// Set env and mock JWKS fetch before any app imports
warnIfSkipped();
setTestEnv();
mockJwksFetch();

import type { FastifyInstance } from 'fastify';
import type { AuthProvider } from '../../src/providers/auth-provider.interface.js';

let pool: pg.Pool;
let app: FastifyInstance;
let provider: AuthProvider;
let signAccessToken: typeof import('../../src/services/token.service.js').signAccessToken;

describe.skipIf(!process.env['DATABASE_URL'])('session routes integration', () => {
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

  it('POST /identity/session with valid provider token returns 200 with tokens', async () => {
    const user = await insertTestUser(pool);
    provider.verifyToken = vi.fn().mockResolvedValue({
      providerUserId: user.provider_user_id,
      email: user.email,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/identity/session',
      payload: { provider_token: 'valid-provider-token' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('access_token');
    expect(body).toHaveProperty('refresh_token');
    expect(body.expires_in).toBe(900);
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
  });

  it('POST /identity/session with inactive user returns 403 account_inactive', async () => {
    const user = await insertTestUser(pool, { status: 'inactive' });
    provider.verifyToken = vi.fn().mockResolvedValue({
      providerUserId: user.provider_user_id,
      email: user.email,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/identity/session',
      payload: { provider_token: 'valid-token' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'account_inactive' });
  });

  it('POST /identity/session with invalid provider token returns 401', async () => {
    provider.verifyToken = vi.fn().mockRejectedValue(new Error('invalid'));

    const res = await app.inject({
      method: 'POST',
      url: '/identity/session',
      payload: { provider_token: 'bad-token' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
  });

  it('POST /identity/refresh with valid token returns 200 with new tokens', async () => {
    const user = await insertTestUser(pool);
    provider.verifyToken = vi.fn().mockResolvedValue({
      providerUserId: user.provider_user_id,
      email: user.email,
    });

    // First create a session to get a refresh token
    const sessionRes = await app.inject({
      method: 'POST',
      url: '/identity/session',
      payload: { provider_token: 'valid-token' },
    });
    const { refresh_token } = sessionRes.json();

    // Now refresh
    const res = await app.inject({
      method: 'POST',
      url: '/identity/refresh',
      payload: { refresh_token },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('access_token');
    expect(body).toHaveProperty('refresh_token');
    expect(body.expires_in).toBe(900);
    // New refresh token should be different
    expect(body.refresh_token).not.toBe(refresh_token);
  });

  it('POST /identity/refresh with revoked token returns 401 session_invalidated (replay)', async () => {
    const user = await insertTestUser(pool);
    provider.verifyToken = vi.fn().mockResolvedValue({
      providerUserId: user.provider_user_id,
      email: user.email,
    });

    // Create session
    const sessionRes = await app.inject({
      method: 'POST',
      url: '/identity/session',
      payload: { provider_token: 'valid-token' },
    });
    const { refresh_token } = sessionRes.json();

    // First refresh (consumes the token)
    await app.inject({
      method: 'POST',
      url: '/identity/refresh',
      payload: { refresh_token },
    });

    // Replay with same token (should detect replay)
    const res = await app.inject({
      method: 'POST',
      url: '/identity/refresh',
      payload: { refresh_token },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('session_invalidated');
  });

  it('DELETE /identity/session revokes refresh token and returns 204', async () => {
    const user = await insertTestUser(pool);
    provider.verifyToken = vi.fn().mockResolvedValue({
      providerUserId: user.provider_user_id,
      email: user.email,
    });

    // Create session
    const sessionRes = await app.inject({
      method: 'POST',
      url: '/identity/session',
      payload: { provider_token: 'valid-token' },
    });
    const { access_token, refresh_token } = sessionRes.json();

    // Delete session
    const res = await app.inject({
      method: 'DELETE',
      url: '/identity/session',
      headers: { authorization: `Bearer ${access_token}` },
      payload: { refresh_token },
    });

    expect(res.statusCode).toBe(204);

    // Trying to refresh with the revoked token should fail
    const refreshRes = await app.inject({
      method: 'POST',
      url: '/identity/refresh',
      payload: { refresh_token },
    });

    // It was revoked by DELETE, so replay detection triggers
    expect(refreshRes.statusCode).toBe(401);
  });
});
