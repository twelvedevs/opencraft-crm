import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fp from 'fastify-plugin';
import requestIdPlugin from '../src/plugins/request-id.js';

// ---------------------------------------------------------------------------
// Hoisted mocks — defined before any top-level code runs
// ---------------------------------------------------------------------------
const mockVerify = vi.hoisted(() => vi.fn());
const mockFrom = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Mock fetch globally — used by auth plugin for JWKS fetch
// ---------------------------------------------------------------------------
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Mock fast-jwt
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
  createVerifier: () => mockVerify,
}));

// ---------------------------------------------------------------------------
// Mock @fastify/reply-from — decorates reply.from with a controllable stub.
// Tests configure mockFrom.mockReturnValue({ status, body, headers }) to
// simulate any upstream response (including 302 redirects).
// ---------------------------------------------------------------------------
vi.mock('@fastify/reply-from', () => ({
  default: fp(
    async (instance: ReturnType<typeof Fastify>) => {
      instance.decorateReply(
        'from',
        function (
          this: ReturnType<ReturnType<typeof Fastify>['inject']> & {
            code: (n: number) => typeof this;
            header: (k: string, v: string) => typeof this;
            send: (body: unknown) => void;
          },
          url: string,
          opts?: unknown,
        ) {
          const result = mockFrom(url, opts) as
            | { status?: number; body?: unknown; headers?: Record<string, string> }
            | undefined;
          const status = result?.status ?? 200;
          const body = result?.body ?? { proxied: true, url };
          const headers = result?.headers ?? {};
          for (const [k, v] of Object.entries(headers)) {
            this.header(k, v);
          }
          this.code(status).send(body);
        },
      );
    },
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeJwt(payload: Record<string, unknown>, kid = 'test-kid'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const jwksMock = { keys: [{ kid: 'test-kid', kty: 'RSA', n: 'abc', e: 'AQAB' }] };

// ---------------------------------------------------------------------------
// Build test app
// ---------------------------------------------------------------------------
async function buildApp() {
  const { default: replyFrom } = await import('@fastify/reply-from');
  const { default: authPlugin } = await import('../src/plugins/auth.js');
  const { default: referralsRoutes } = await import('../src/routes/referrals.js');

  const app = Fastify({ logger: false });
  await app.register(replyFrom);
  await app.register(requestIdPlugin);
  await app.register(authPlugin);

  mockVerify.mockReturnValue({
    sub: 'user-1',
    role: 'call_center_agent',
    locations: [],
    must_change_password: false,
  });

  await app.register(referralsRoutes, { prefix: '/v1/referrals' });
  await app.ready();
  return app;
}

function makeAuth(): string {
  return `Bearer ${makeJwt({ sub: 'u1', role: 'call_center_agent', locations: [], must_change_password: false })}`;
}

describe('referrals route', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(mockResponse(200, jwksMock));
    // Default: upstream returns 200 with proxied body
    mockFrom.mockReturnValue({ status: 200, body: { proxied: true } });
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // -------------------------------------------------------------------------
  // GET /v1/referrals/r/:code — public, click redirect
  // -------------------------------------------------------------------------
  it('GET /r/:code: no Authorization → not 401 (public route)', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/referrals/r/abc123' });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(200);
  });

  it('GET /r/:code: upstream 302 forwarded without following the redirect', async () => {
    app = await buildApp();
    mockFrom.mockReturnValueOnce({
      status: 302,
      headers: { Location: 'https://example.com/referral' },
      body: '',
    });
    const res = await app.inject({ method: 'GET', url: '/v1/referrals/r/abc123' });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe('https://example.com/referral');
  });

  // -------------------------------------------------------------------------
  // GET /v1/referrals/links/:code — public
  // -------------------------------------------------------------------------
  it('GET /links/:code: no Authorization → not 401 (public route)', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/referrals/links/link-code' });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // GET /v1/referrals/portal/:token — public
  // -------------------------------------------------------------------------
  it('GET /portal/:token: no Authorization → not 401 (public route)', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/referrals/portal/some-token' });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Non-public routes — JWT required
  // -------------------------------------------------------------------------
  it('GET non-public route: no Authorization → 401 unauthorized', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/referrals/list' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('GET non-public route: valid JWT → 200 forwarded', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/referrals/list',
      headers: { Authorization: makeAuth() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ proxied: true });
  });

  it('POST non-public route: no Authorization → 401 unauthorized', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/referrals/generate',
      headers: { 'Content-Type': 'application/json' },
      payload: JSON.stringify({ patientId: 'p-1' }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('POST non-public route: valid JWT → 200 forwarded', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/referrals/generate',
      headers: { Authorization: makeAuth(), 'Content-Type': 'application/json' },
      payload: JSON.stringify({ patientId: 'p-1' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ proxied: true });
  });
});
