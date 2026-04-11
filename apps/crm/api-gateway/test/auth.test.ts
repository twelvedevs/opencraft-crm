import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fp from 'fastify-plugin';
import requestIdPlugin from '../src/plugins/request-id.js';
import { clearCache } from '../src/lib/api-key-cache.js';

// ---------------------------------------------------------------------------
// Mock fetch globally — used by auth plugin for JWKS + API key validation
// Setup env is handled by test/setup.ts (loaded before this module)
// ---------------------------------------------------------------------------
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Mock fast-jwt — lets us simulate valid/invalid/expired tokens without real
// RSA keys. The auth plugin uses fast-jwt's createDecoder / createVerifier.
// ---------------------------------------------------------------------------
const mockVerify = vi.fn();

vi.mock('fast-jwt', () => ({
  createDecoder: () => (token: string) => {
    // Parse base64url-encoded header/payload (our makeJwt format)
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('invalid token');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return { header, payload };
  },
  createVerifier: () => mockVerify,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake JWT (no real signing) — decoded by the mocked fast-jwt */
function makeJwt(payload: Record<string, unknown>, kid = 'test-kid'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fake-sig`;
}

/** Build a Response mock */
function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Standard valid JWT claims */
const validClaims = {
  sub: 'user-123',
  role: 'call_center_agent',
  locations: ['loc-1', 'loc-2'],
  must_change_password: false,
};

// ---------------------------------------------------------------------------
// Build a test Fastify app with auth plugin + protected + public routes
// ---------------------------------------------------------------------------
async function buildApp() {
  const { default: authPlugin } = await import('../src/plugins/auth.js');

  const app = Fastify({ logger: false });
  await app.register(requestIdPlugin);
  await app.register(authPlugin);

  await app.register(
    fp(async (instance) => {
      instance.get('/protected', (request, reply) => {
        return reply.send({
          authType: request.authType,
          authHeaders: request.authHeaders,
          jwtClaims: request.jwtClaims,
          apiKeyContext: request.apiKeyContext
            ? { permissions: request.apiKeyContext.permissions }
            : undefined,
        });
      });

      instance.get('/public', { config: { auth: false } }, (request, reply) => {
        return reply.send({ authType: request.authType });
      });
    }),
    { prefix: '/' },
  );

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// JWKS mock — returned on startup to warm the key cache
// ---------------------------------------------------------------------------
const jwksMock = {
  keys: [{ kid: 'test-kid', kty: 'RSA', n: 'abc123', e: 'AQAB' }],
};

describe('auth plugin', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(() => {
    clearCache();
    vi.clearAllMocks();
    // Default JWKS fetch succeeds at startup
    mockFetch.mockResolvedValue(mockResponse(200, jwksMock));
    // Default verifier succeeds with valid claims
    mockVerify.mockReturnValue(validClaims);
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // -------------------------------------------------------------------------
  // Public route — no auth required
  // -------------------------------------------------------------------------
  it('public route: no Authorization header → 200 (no 401)', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/public' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ authType: 'public' });
  });

  // -------------------------------------------------------------------------
  // No Authorization on protected route → 401
  // -------------------------------------------------------------------------
  it('protected route: no Authorization → 401 unauthorized', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  // -------------------------------------------------------------------------
  // Header spoofing — synthetic headers stripped on every request
  // -------------------------------------------------------------------------
  it('strips spoofed synthetic headers before routing', async () => {
    app = await buildApp();
    const token = makeJwt(validClaims);
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-user-id': 'spoofed',
        'x-user-role': 'super_admin',
        'x-user-locations': 'fake',
        'x-api-key-permissions': 'everything',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { authHeaders: Record<string, string> };
    // Gateway-injected values should come from JWT claims, not spoofed values
    expect(body.authHeaders['X-User-Id']).toBe('user-123');
    expect(body.authHeaders['X-User-Role']).toBe('call_center_agent');
  });

  // -------------------------------------------------------------------------
  // JWT valid → 200, correct headers injected
  // -------------------------------------------------------------------------
  it('JWT valid → 200, X-User-Id/Role/Locations injected, Authorization forwarded', async () => {
    app = await buildApp();
    const token = makeJwt(validClaims);
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { authType: string; authHeaders: Record<string, string> };
    expect(body.authType).toBe('jwt');
    expect(body.authHeaders['X-User-Id']).toBe('user-123');
    expect(body.authHeaders['X-User-Role']).toBe('call_center_agent');
    expect(body.authHeaders['X-User-Locations']).toBe('loc-1,loc-2');
    expect(body.authHeaders['Authorization']).toMatch(/^Bearer /);
  });

  // -------------------------------------------------------------------------
  // JWT invalid — verifier throws
  // -------------------------------------------------------------------------
  it('JWT invalid/malformed → 401', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: 'Bearer not.a.jwt.at.all' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  // -------------------------------------------------------------------------
  // JWT expired — verifier throws
  // -------------------------------------------------------------------------
  it('JWT expired → 401', async () => {
    mockVerify.mockImplementationOnce(() => {
      throw new Error('jwt expired');
    });
    app = await buildApp();
    const token = makeJwt({ ...validClaims, exp: 1 });
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  // -------------------------------------------------------------------------
  // JWT must_change_password: true → 403 on ALL routes
  // -------------------------------------------------------------------------
  it('JWT must_change_password: true → 403 password_change_required', async () => {
    const claims = { ...validClaims, must_change_password: true };
    mockVerify.mockReturnValue(claims);
    app = await buildApp();
    const token = makeJwt(claims);
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'password_change_required' });
  });

  // -------------------------------------------------------------------------
  // JWT with empty locations[] → X-User-Locations OMITTED
  // -------------------------------------------------------------------------
  it('JWT with empty locations[] → X-User-Locations header omitted', async () => {
    const claims = { ...validClaims, locations: [] };
    mockVerify.mockReturnValue(claims);
    app = await buildApp();
    const token = makeJwt(claims);
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { authHeaders: Record<string, string> };
    expect(body.authHeaders['X-User-Locations']).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // JWT — unknown kid, JWKS unreachable → 401
  // -------------------------------------------------------------------------
  it('JWT with unknown kid, JWKS unreachable → 401', async () => {
    // Startup JWKS succeeds (empty, so no kids cached)
    mockFetch.mockResolvedValueOnce(mockResponse(200, { keys: [] }));
    // Re-fetch for unknown kid fails
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    app = await buildApp();
    const token = makeJwt(validClaims, 'unknown-kid');
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  // -------------------------------------------------------------------------
  // API key path — cache miss: Identity Service called
  // -------------------------------------------------------------------------
  it('API key (cache miss): Identity Service called, permissions cached', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(200, jwksMock)) // JWKS startup
      .mockResolvedValueOnce(mockResponse(200, { permissions: ['leads:read'] })); // validate

    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: 'Bearer ak_test-key-123' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { authType: string; authHeaders: Record<string, string> };
    expect(body.authType).toBe('api-key');
    expect(body.authHeaders['X-Api-Key-Permissions']).toBe('leads:read');

    const validateCall = mockFetch.mock.calls.find((c) =>
      (c[0] as string).includes('/identity/api-keys/validate'),
    );
    expect(validateCall).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // API key path — cache hit: Identity NOT called second time
  // -------------------------------------------------------------------------
  it('API key (cache hit): Identity Service NOT called on second request', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(200, jwksMock)) // JWKS startup
      .mockResolvedValueOnce(mockResponse(200, { permissions: ['leads:read'] })); // first validate

    app = await buildApp();
    await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: 'Bearer ak_test-key-123' },
    });
    const callsAfterFirst = mockFetch.mock.calls.length;

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: 'Bearer ak_test-key-123' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockFetch.mock.calls.length).toBe(callsAfterFirst); // no new calls
  });

  // -------------------------------------------------------------------------
  // API key path — Identity returns 401 → 401 unauthorized
  // -------------------------------------------------------------------------
  it('API key: Identity returns 401 → 401 unauthorized', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(200, jwksMock))
      .mockResolvedValueOnce(mockResponse(401, { error: 'invalid_key' }));

    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: 'Bearer ak_invalid' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  // -------------------------------------------------------------------------
  // API key path — Identity unreachable → 503 (fail closed)
  // -------------------------------------------------------------------------
  it('API key: Identity unreachable → 503 auth_unavailable (fail closed)', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(200, jwksMock))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));

    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: 'Bearer ak_some-key' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'auth_unavailable' });
  });

  // -------------------------------------------------------------------------
  // API key — Authorization header NOT forwarded
  // -------------------------------------------------------------------------
  it('API key: Authorization header NOT forwarded to upstream', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(200, jwksMock))
      .mockResolvedValueOnce(mockResponse(200, { permissions: ['write'] }));

    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { Authorization: 'Bearer ak_test-key' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { authHeaders: Record<string, string> };
    expect(body.authHeaders['Authorization']).toBeUndefined();
    expect(body.authHeaders['X-Api-Key-Permissions']).toBeDefined();
  });
});
