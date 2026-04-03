import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeyPairSync, createSign } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { authPlugin } from '../src/plugin.js';

// Generate two distinct RSA key pairs
function makeKeyPair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const jwk = {
    ...require('node:crypto').createPublicKey(publicKey).export({ format: 'jwk' }),
    kid,
    kty: 'RSA',
    use: 'sig',
    alg: 'RS256',
  };
  return { privateKey, publicKey, jwk };
}

function makeJwt(privateKey: string, kid: string, payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900, ...payload })).toString('base64url');
  const signing = `${header}.${body}`;
  const sign = createSign('RSA-SHA256');
  sign.update(signing);
  const sig = sign.sign(privateKey, 'base64url');
  return `${signing}.${sig}`;
}

const JWKS_URL = 'http://test-identity/.well-known/jwks.json';

describe('@ortho/auth-middleware JWKS cache', () => {
  const key1 = makeKeyPair('kid-1');
  const key2 = makeKeyPair('kid-2');

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  async function buildApp(initialKeys: object[]): Promise<FastifyInstance> {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ keys: initialKeys }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const app = Fastify({ logger: false });
    await app.register(authPlugin, { jwksUrl: JWKS_URL, allowedPaths: ['/public'] });

    app.get('/protected', async (req, reply) => {
      return reply.send({ sub: req.user.sub });
    });

    await app.ready();
    return app;
  }

  it('accepts a JWT signed with a key present in the initial JWKS', async () => {
    const app = await buildApp([key1.jwk]);
    const token = makeJwt(key1.privateKey, 'kid-1', { sub: 'user-1', role: 'super_admin', locations: [], must_change_password: false });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('evicts retired keys from cache when JWKS is re-fetched on unknown kid', async () => {
    // Initial JWKS: only kid-1
    const app = await buildApp([key1.jwk]);

    // Re-fetch returns only kid-2 (kid-1 retired)
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ keys: [key2.jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    // First: present a JWT with kid-2 (unknown) to trigger re-fetch
    const tokenKid2 = makeJwt(key2.privateKey, 'kid-2', { sub: 'user-2', role: 'super_admin', locations: [], must_change_password: false });
    const refetchRes = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${tokenKid2}` },
    });
    // After re-fetch, kid-2 is in cache, kid-1 should be evicted
    expect(refetchRes.statusCode).toBe(200);

    // Now: a JWT with kid-1 (retired) must be rejected
    const tokenKid1 = makeJwt(key1.privateKey, 'kid-1', { sub: 'user-1', role: 'super_admin', locations: [], must_change_password: false });
    const retiredRes = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${tokenKid1}` },
    });

    // With bug: kid-1 still in cache → 200. With fix: kid-1 evicted → 401.
    expect(retiredRes.statusCode).toBe(401);

    await app.close();
  });
});
