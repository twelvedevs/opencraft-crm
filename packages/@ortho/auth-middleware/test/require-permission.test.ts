import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import { authPlugin } from '../src/plugin.js';
import { requirePermission } from '../src/require-permission.js';
import { makeKeyPair, makeJwt, JWKS_URL, buildApp } from './helpers.js';

const key = makeKeyPair('kid-1');

afterEach(() => {
  vi.unstubAllGlobals();
});

function token(role: string, extra: Record<string, unknown> = {}) {
  return makeJwt(key.privateKey, 'kid-1', {
    sub: 'user-1',
    role,
    locations: [],
    must_change_password: false,
    ...extra,
  });
}

async function buildAppWithPermission(permission: string) {
  const app = await buildApp([key.jwk]);
  app.get(
    '/resource',
    { preHandler: requirePermission(permission) },
    async (_req, reply) => reply.send({ ok: true }),
  );
  await app.ready();
  return app;
}

describe('requirePermission', () => {
  it('allows a role that has the required permission', async () => {
    const app = await buildAppWithPermission('leads:read');

    const res = await app.inject({
      method: 'GET',
      url: '/resource',
      headers: { authorization: `Bearer ${token('call_center_agent')}` },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns 403 when the role lacks the required permission', async () => {
    const app = await buildAppWithPermission('campaigns:write');

    const res = await app.inject({
      method: 'GET',
      url: '/resource',
      headers: { authorization: `Bearer ${token('call_center_agent')}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
    await app.close();
  });

  // super_admin bypasses all permission checks — spec §5 "bypasses all permission checks"
  it('allows super_admin for a permission not explicitly in their list', async () => {
    // Use a permission that does not exist in ROLE_PERMISSIONS at all
    const app = await buildAppWithPermission('nonexistent:permission');

    const res = await app.inject({
      method: 'GET',
      url: '/resource',
      headers: { authorization: `Bearer ${token('super_admin')}` },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
