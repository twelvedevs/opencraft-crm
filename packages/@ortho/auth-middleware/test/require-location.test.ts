import { describe, it, expect, vi, afterEach } from 'vitest';
import { requireLocation } from '../src/require-location.js';
import { makeKeyPair, makeJwt, buildApp } from './helpers.js';

const key = makeKeyPair('kid-1');

afterEach(() => {
  vi.unstubAllGlobals();
});

function token(role: string, locations: string[]) {
  return makeJwt(key.privateKey, 'kid-1', {
    sub: 'user-1',
    role,
    locations,
    must_change_password: false,
  });
}

async function buildAppWithLocation() {
  const app = await buildApp([key.jwk]);
  // Route with location_id in params
  app.get(
    '/locations/:location_id/leads',
    { preHandler: requireLocation() },
    async (_req, reply) => reply.send({ ok: true }),
  );
  // Route with location_id in query string
  app.get(
    '/leads',
    { preHandler: requireLocation() },
    async (_req, reply) => reply.send({ ok: true }),
  );
  await app.ready();
  return app;
}

describe('requireLocation', () => {
  it('allows call_center_agent when location_id param matches their assigned location', async () => {
    const app = await buildAppWithLocation();

    const res = await app.inject({
      method: 'GET',
      url: '/locations/loc-abc/leads',
      headers: { authorization: `Bearer ${token('call_center_agent', ['loc-abc'])}` },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns 403 for call_center_agent when location_id does not match', async () => {
    const app = await buildAppWithLocation();

    const res = await app.inject({
      method: 'GET',
      url: '/locations/loc-other/leads',
      headers: { authorization: `Bearer ${token('call_center_agent', ['loc-abc'])}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
    await app.close();
  });

  it('returns 403 when location_id is missing from params and query', async () => {
    const app = await buildAppWithLocation();

    const res = await app.inject({
      method: 'GET',
      url: '/leads',
      headers: { authorization: `Bearer ${token('call_center_agent', ['loc-abc'])}` },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('allows call_center_agent when location_id is passed in query string', async () => {
    const app = await buildAppWithLocation();

    const res = await app.inject({
      method: 'GET',
      url: '/leads?location_id=loc-abc',
      headers: { authorization: `Bearer ${token('call_center_agent', ['loc-abc'])}` },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('bypasses location check for marketing_staff', async () => {
    const app = await buildAppWithLocation();

    const res = await app.inject({
      method: 'GET',
      url: '/leads',
      headers: { authorization: `Bearer ${token('marketing_staff', [])}` },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('bypasses location check for marketing_manager', async () => {
    const app = await buildAppWithLocation();

    const res = await app.inject({
      method: 'GET',
      url: '/leads',
      headers: { authorization: `Bearer ${token('marketing_manager', [])}` },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('bypasses location check for super_admin', async () => {
    const app = await buildAppWithLocation();

    const res = await app.inject({
      method: 'GET',
      url: '/leads',
      headers: { authorization: `Bearer ${token('super_admin', [])}` },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
