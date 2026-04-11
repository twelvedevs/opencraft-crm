import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { FastifyRequest } from 'fastify';
import { clearCache } from '../src/lib/api-key-cache.js';
// error-handler is needed so thrown rate-limit errors (with statusCode) are
// normalized to { error: string } with the correct HTTP status code.
// Without it, Fastify would default to 500 for thrown plain objects.

// ---------------------------------------------------------------------------
// Mock fetch globally — used by auth plugin for JWKS and API key validation
// ---------------------------------------------------------------------------
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Mock fast-jwt — verifier decodes the token payload directly so different
// subs in different test JWTs produce different rate-limit keys without
// needing real RSA key pairs.
// ---------------------------------------------------------------------------
vi.mock('fast-jwt', () => ({
  createDecoder: () => (token: string) => {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('invalid token');
    return {
      header: JSON.parse(Buffer.from(parts[0], 'base64url').toString()),
      payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString()),
    };
  },
  createVerifier: () => (token: string) => {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('invalid');
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeJwt(sub: string, kid = 'test-kid'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({ sub, role: 'call_center_agent', locations: [], must_change_password: false }),
  ).toString('base64url');
  return `${header}.${body}.sig`;
}

const jwksMock = { keys: [{ kid: 'test-kid', kty: 'RSA', n: 'abc', e: 'AQAB' }] };

// Low limits for test speed — same tier logic as src/plugins/rate-limit.ts
// but values small enough to exhaust in a handful of inject() calls.
const PUBLIC_LIMIT = 3;
const JWT_LIMIT = 4;
const API_KEY_LIMIT = 5;

// ---------------------------------------------------------------------------
// Build test app — auth plugin (real, for type augmentations + header parsing)
// + @fastify/rate-limit registered directly with low limits.
// Three routes: /public (auth: false), /protected (JWT/API key), /health
// ---------------------------------------------------------------------------
async function buildApp() {
  const { default: authPlugin } = await import('../src/plugins/auth.js');
  const { default: errorHandlerPlugin } = await import('../src/plugins/error-handler.js');

  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);

  await app.register(rateLimit, {
    global: true,
    hook: 'preHandler',
    // Skip routes flagged with config.skipRateLimit
    allowList: (request: FastifyRequest) => {
      const cfg = request.routeOptions?.config as unknown as Record<string, unknown> | undefined;
      return cfg?.['skipRateLimit'] === true;
    },
    // Same tier key logic as the production plugin
    keyGenerator: (request: FastifyRequest) => {
      if (request.authType === 'jwt' && request.jwtClaims) {
        return `jwt:${request.jwtClaims.sub}`;
      }
      if (request.authType === 'api-key' && request.apiKeyContext) {
        return `ak:${request.apiKeyContext.keyHash}`;
      }
      const forwarded = request.headers['x-forwarded-for'];
      if (forwarded) {
        const ips = (typeof forwarded === 'string' ? forwarded : forwarded[0]).split(',');
        return `ip:${ips[ips.length - 1].trim()}`;
      }
      return `ip:${request.ip}`;
    },
    // Low per-tier limits for test speed
    max: (request: FastifyRequest) => {
      if (request.authType === 'jwt') return JWT_LIMIT;
      if (request.authType === 'api-key') return API_KEY_LIMIT;
      return PUBLIC_LIMIT;
    },
    timeWindow: 60_000,
    errorResponseBuilder: (_request: FastifyRequest, context: { statusCode: number }) => ({
      error: 'rate_limit_exceeded',
      message: 'rate_limit_exceeded',
      statusCode: context.statusCode,
    }),
  });

  // Public route — for IP-based (public) tier testing
  app.get('/public', { config: { auth: false } }, (_request, reply) => reply.send({ ok: true }));
  // Protected route — for JWT and API key tier testing
  app.get('/protected', (_request, reply) => reply.send({ ok: true }));
  // Health — must be excluded from rate limiting entirely
  app.get(
    '/health',
    { config: { auth: false, skipRateLimit: true } },
    (_request, reply) => reply.send({ status: 'ok' }),
  );

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('rate-limit plugin', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(() => {
    clearCache();
    vi.clearAllMocks();
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('.well-known/jwks.json')) {
        return Promise.resolve(mockResponse(200, jwksMock));
      }
      if (url.includes('/identity/api-keys/validate')) {
        return Promise.resolve(mockResponse(200, { permissions: ['read'] }));
      }
      return Promise.resolve(mockResponse(200, {}));
    });
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // -------------------------------------------------------------------------
  // Public tier — keyed by rightmost X-Forwarded-For IP
  // -------------------------------------------------------------------------
  it('public tier: same IP → 429 after limit exceeded, Retry-After header present', async () => {
    app = await buildApp();

    for (let i = 0; i < PUBLIC_LIMIT; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/public',
        headers: { 'x-forwarded-for': '10.0.0.1' },
      });
      expect(res.statusCode).toBe(200);
    }

    const over = await app.inject({
      method: 'GET',
      url: '/public',
      headers: { 'x-forwarded-for': '10.0.0.1' },
    });
    expect(over.statusCode).toBe(429);
    expect(over.json()).toEqual({ error: 'rate_limit_exceeded' });
    expect(over.headers['retry-after']).toBeDefined();
  });

  it('public tier: different IP not rate limited after first IP is exhausted', async () => {
    app = await buildApp();

    // Exhaust 10.0.0.1
    for (let i = 0; i <= PUBLIC_LIMIT; i++) {
      await app.inject({
        method: 'GET',
        url: '/public',
        headers: { 'x-forwarded-for': '10.0.0.1' },
      });
    }

    // Different IP still succeeds
    const res = await app.inject({
      method: 'GET',
      url: '/public',
      headers: { 'x-forwarded-for': '10.0.0.2' },
    });
    expect(res.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // JWT tier — keyed by sub claim
  // -------------------------------------------------------------------------
  it('JWT tier: same sub → 429 after limit exceeded, Retry-After header present', async () => {
    app = await buildApp();
    const token = makeJwt('user-alpha');

    for (let i = 0; i < JWT_LIMIT; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    }

    const over = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(over.statusCode).toBe(429);
    expect(over.json()).toEqual({ error: 'rate_limit_exceeded' });
    expect(over.headers['retry-after']).toBeDefined();
  });

  it('JWT tier: different sub not affected by first sub exhaustion', async () => {
    app = await buildApp();
    const token1 = makeJwt('user-alpha');
    const token2 = makeJwt('user-beta');

    // Exhaust user-alpha
    for (let i = 0; i <= JWT_LIMIT; i++) {
      await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { Authorization: `Bearer ${token1}` },
      });
    }

    // user-beta still works
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: `Bearer ${token2}` },
    });
    expect(res.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // API key tier — keyed by SHA-256 hash of raw key
  // -------------------------------------------------------------------------
  it('API key tier: same key → 429 after limit exceeded, Retry-After header present', async () => {
    app = await buildApp();

    for (let i = 0; i < API_KEY_LIMIT; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { Authorization: 'Bearer ak_test-key-one' },
      });
      expect(res.statusCode).toBe(200);
    }

    const over = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: 'Bearer ak_test-key-one' },
    });
    expect(over.statusCode).toBe(429);
    expect(over.json()).toEqual({ error: 'rate_limit_exceeded' });
    expect(over.headers['retry-after']).toBeDefined();
  });

  it('API key tier: different key not affected after first key is exhausted', async () => {
    app = await buildApp();

    // Exhaust ak_test-key-one
    for (let i = 0; i <= API_KEY_LIMIT; i++) {
      await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { Authorization: 'Bearer ak_test-key-one' },
      });
    }

    // Different key still works
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: 'Bearer ak_test-key-two' },
    });
    expect(res.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // GET /health — excluded from rate limiting
  // -------------------------------------------------------------------------
  it('GET /health: unlimited requests → never 429 regardless of IP', async () => {
    app = await buildApp();

    for (let i = 0; i < PUBLIC_LIMIT + 10; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-forwarded-for': '10.0.0.1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.statusCode).not.toBe(429);
    }
  });
});
