import { describe, it, expect, vi, afterEach } from 'vitest';
import { requireRole } from '../src/require-role.js';
import { makeKeyPair, makeJwt, buildApp } from './helpers.js';

const key = makeKeyPair('kid-1');

afterEach(() => {
  vi.unstubAllGlobals();
});

function token(role: string) {
  return makeJwt(key.privateKey, 'kid-1', {
    sub: 'user-1',
    role,
    locations: [],
    must_change_password: false,
  });
}

async function buildAppWithRole(allowedRoles: string[]) {
  const app = await buildApp([key.jwk]);
  app.get(
    '/resource',
    { preHandler: requireRole(allowedRoles) },
    async (_req, reply) => reply.send({ ok: true }),
  );
  await app.ready();
  return app;
}

describe('requireRole', () => {
  it('allows a request when the user role is in the allowed list', async () => {
    const app = await buildAppWithRole(['marketing_manager', 'super_admin']);

    const res = await app.inject({
      method: 'GET',
      url: '/resource',
      headers: { authorization: `Bearer ${token('marketing_manager')}` },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns 403 when the user role is not in the allowed list', async () => {
    const app = await buildAppWithRole(['marketing_manager', 'super_admin']);

    const res = await app.inject({
      method: 'GET',
      url: '/resource',
      headers: { authorization: `Bearer ${token('call_center_agent')}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
    await app.close();
  });

  it('allows super_admin when super_admin is in the allowed list', async () => {
    const app = await buildAppWithRole(['super_admin']);

    const res = await app.inject({
      method: 'GET',
      url: '/resource',
      headers: { authorization: `Bearer ${token('super_admin')}` },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns 403 for super_admin when super_admin is not in the allowed list', async () => {
    const app = await buildAppWithRole(['call_center_agent']);

    const res = await app.inject({
      method: 'GET',
      url: '/resource',
      headers: { authorization: `Bearer ${token('super_admin')}` },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
