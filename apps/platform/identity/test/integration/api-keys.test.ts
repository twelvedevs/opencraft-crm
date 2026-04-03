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

function adminToken(userId: string) {
  return signAccessToken({
    sub: userId,
    role: 'super_admin',
    locations: [],
    must_change_password: false,
  });
}

describe.skipIf(!process.env['DATABASE_URL'])('api-keys routes integration', () => {
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

  it('POST /identity/api-keys creates key and returns 201 with ak_ prefixed key', async () => {
    const admin = await insertTestUser(pool);
    const token = adminToken(admin.id);

    const res = await app.inject({
      method: 'POST',
      url: '/identity/api-keys',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'Test API Key',
        permissions: ['leads:read', 'leads:write'],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.name).toBe('Test API Key');
    expect(body.key).toMatch(/^ak_[a-f0-9]{64}$/);
    expect(body.permissions).toEqual(['leads:read', 'leads:write']);
  });

  it('GET /identity/api-keys lists keys without key_hash', async () => {
    const admin = await insertTestUser(pool);
    const token = adminToken(admin.id);

    // Create a key first
    await app.inject({
      method: 'POST',
      url: '/identity/api-keys',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Key 1', permissions: ['leads:read'] },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/identity/api-keys',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].name).toBe('Key 1');
    expect(body.keys[0].status).toBe('active');
    expect(body.keys[0]).not.toHaveProperty('key_hash');
    expect(body.keys[0]).not.toHaveProperty('key');
  });

  it('POST /identity/api-keys/validate with correct X-Internal-Secret returns 200 with permissions', async () => {
    const admin = await insertTestUser(pool);
    const token = adminToken(admin.id);

    // Create a key
    const createRes = await app.inject({
      method: 'POST',
      url: '/identity/api-keys',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Validate Key', permissions: ['leads:read', 'pipeline:read'] },
    });
    const { key } = createRes.json();

    // Validate the key (internal endpoint)
    const res = await app.inject({
      method: 'POST',
      url: '/identity/api-keys/validate',
      headers: { 'x-internal-secret': 'test-internal-secret' },
      payload: { key },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().permissions).toEqual(['leads:read', 'pipeline:read']);
  });

  it('POST /identity/api-keys/validate without X-Internal-Secret returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/identity/api-keys/validate',
      payload: { key: 'ak_somefakekey' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthorized');
  });

  it('POST /identity/api-keys/validate with wrong X-Internal-Secret returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/identity/api-keys/validate',
      headers: { 'x-internal-secret': 'wrong-secret' },
      payload: { key: 'ak_somefakekey' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthorized');
  });

  it('DELETE /identity/api-keys/:id revokes key and returns 204', async () => {
    const admin = await insertTestUser(pool);
    const token = adminToken(admin.id);

    // Create a key
    const createRes = await app.inject({
      method: 'POST',
      url: '/identity/api-keys',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'To Revoke', permissions: ['leads:read'] },
    });
    const { id, key } = createRes.json();

    // Revoke
    const res = await app.inject({
      method: 'DELETE',
      url: `/identity/api-keys/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(204);

    // Validate should now fail
    const validateRes = await app.inject({
      method: 'POST',
      url: '/identity/api-keys/validate',
      headers: { 'x-internal-secret': 'test-internal-secret' },
      payload: { key },
    });

    expect(validateRes.statusCode).toBe(401);
    expect(validateRes.json().error).toBe('invalid_key');
  });

  it('DELETE /identity/api-keys/:id with unknown id returns 404', async () => {
    const admin = await insertTestUser(pool);
    const token = adminToken(admin.id);

    const res = await app.inject({
      method: 'DELETE',
      url: '/identity/api-keys/00000000-0000-0000-0000-000000000099',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
  });
});
