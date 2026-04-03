import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeKeyPair, makeJwt, JWKS_URL, buildApp } from './helpers.js';

const key1 = makeKeyPair('kid-1');
const key2 = makeKeyPair('kid-2');

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  vi.unstubAllGlobals();
});

describe('JWKS cache — key acceptance and rotation', () => {
  it('accepts a JWT signed with a key present in the initial JWKS', async () => {
    const app = await buildApp([key1.jwk]);
    app.get('/protected', async (req, reply) => reply.send({ sub: req.user?.sub }));
    await app.ready();

    const token = makeJwt(key1.privateKey, 'kid-1', {
      sub: 'user-1',
      role: 'super_admin',
      locations: [],
      must_change_password: false,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('evicts retired keys from cache when JWKS is re-fetched on unknown kid', async () => {
    const app = await buildApp([key1.jwk]);
    app.get('/protected', async (req, reply) => reply.send({ sub: req.user?.sub }));
    await app.ready();

    // Re-fetch returns only kid-2 (kid-1 retired)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ keys: [key2.jwk] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const tokenKid2 = makeJwt(key2.privateKey, 'kid-2', {
      sub: 'user-2',
      role: 'super_admin',
      locations: [],
      must_change_password: false,
    });
    const refetchRes = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${tokenKid2}` },
    });
    expect(refetchRes.statusCode).toBe(200);

    const tokenKid1 = makeJwt(key1.privateKey, 'kid-1', {
      sub: 'user-1',
      role: 'super_admin',
      locations: [],
      must_change_password: false,
    });
    const retiredRes = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${tokenKid1}` },
    });

    expect(retiredRes.statusCode).toBe(401);
    await app.close();
  });
});

describe('token rejection', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const app = await buildApp([key1.jwk]);
    app.get('/protected', async (_req, reply) => reply.send({}));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/protected' });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_token' });
    await app.close();
  });

  it('returns 401 when token is malformed', async () => {
    const app = await buildApp([key1.jwk]);
    app.get('/protected', async (_req, reply) => reply.send({}));
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer not.a.jwt' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_token' });
    await app.close();
  });

  it('returns 401 when token is signed by an unknown key', async () => {
    const app = await buildApp([key1.jwk]);
    app.get('/protected', async (_req, reply) => reply.send({}));
    await app.ready();

    const token = makeJwt(key2.privateKey, 'kid-unknown', {
      sub: 'attacker',
      role: 'super_admin',
      locations: [],
      must_change_password: false,
    });

    // re-fetch also returns no matching key
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ keys: [key1.jwk] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('allowedPaths bypass', () => {
  it('allows unauthenticated requests to paths in allowedPaths', async () => {
    const app = await buildApp([key1.jwk], { allowedPaths: ['/public'] });
    app.get('/public', async (_req, reply) => reply.send({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/public' });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('still rejects unauthenticated requests to paths not in allowedPaths', async () => {
    const app = await buildApp([key1.jwk], { allowedPaths: ['/public'] });
    app.get('/protected', async (_req, reply) => reply.send({}));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/protected' });

    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('must_change_password enforcement', () => {
  it('returns 403 on protected routes when must_change_password is true', async () => {
    const app = await buildApp([key1.jwk]);
    app.get('/some/resource', async (_req, reply) => reply.send({}));
    await app.ready();

    const token = makeJwt(key1.privateKey, 'kid-1', {
      sub: 'user-1',
      role: 'call_center_agent',
      locations: ['loc-1'],
      must_change_password: true,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/some/resource',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'password_change_required' });
    await app.close();
  });

  it('allows PUT /identity/me/password when must_change_password is true', async () => {
    const app = await buildApp([key1.jwk]);
    app.put('/identity/me/password', async (_req, reply) => reply.send({}));
    await app.ready();

    const token = makeJwt(key1.privateKey, 'kid-1', {
      sub: 'user-1',
      role: 'call_center_agent',
      locations: ['loc-1'],
      must_change_password: true,
    });

    const res = await app.inject({
      method: 'PUT',
      url: '/identity/me/password',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('allows GET /identity/me when must_change_password is true', async () => {
    const app = await buildApp([key1.jwk]);
    app.get('/identity/me', async (_req, reply) => reply.send({}));
    await app.ready();

    const token = makeJwt(key1.privateKey, 'kid-1', {
      sub: 'user-1',
      role: 'call_center_agent',
      locations: ['loc-1'],
      must_change_password: true,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/identity/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('allows DELETE /identity/session when must_change_password is true', async () => {
    const app = await buildApp([key1.jwk]);
    app.delete('/identity/session', async (_req, reply) => reply.send({}));
    await app.ready();

    const token = makeJwt(key1.privateKey, 'kid-1', {
      sub: 'user-1',
      role: 'call_center_agent',
      locations: ['loc-1'],
      must_change_password: true,
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/identity/session',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('passes normally when must_change_password is false', async () => {
    const app = await buildApp([key1.jwk]);
    app.get('/some/resource', async (_req, reply) => reply.send({}));
    await app.ready();

    const token = makeJwt(key1.privateKey, 'kid-1', {
      sub: 'user-1',
      role: 'call_center_agent',
      locations: ['loc-1'],
      must_change_password: false,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/some/resource',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
