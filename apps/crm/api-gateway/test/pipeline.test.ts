import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fp from 'fastify-plugin';
import requestIdPlugin from '../src/plugins/request-id.js';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be defined before other top-level code so they are
// available when vi.mock factory functions run.
// ---------------------------------------------------------------------------
const mockResolveChannel = vi.hoisted(() => vi.fn());
const mockVerify = vi.hoisted(() => vi.fn());
const mockFrom = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Mock fetch globally
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
// Mock channel-resolver
// ---------------------------------------------------------------------------
vi.mock('../src/lib/channel-resolver.js', () => ({
  resolveChannel: mockResolveChannel,
}));

// ---------------------------------------------------------------------------
// Mock @fastify/reply-from — registers a plugin that decorates reply.from
// ---------------------------------------------------------------------------
vi.mock('@fastify/reply-from', () => ({
  default: fp(async (instance: ReturnType<typeof Fastify>) => {
    instance.decorateReply('from', function (
      this: ReturnType<ReturnType<typeof Fastify>['inject']> & { send: (body: unknown) => void },
      url: string,
      opts?: { body?: unknown; rewriteRequestHeaders?: unknown },
    ) {
      mockFrom(url, opts);
      this.send({ proxied: true, forwardedBody: opts?.body ?? null, url });
    });
  }),
  fastifyReplyFrom: fp(async () => {}),
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
async function buildApp(role = 'call_center_agent') {
  const { default: replyFrom } = await import('@fastify/reply-from');
  const { default: authPlugin } = await import('../src/plugins/auth.js');
  const { default: pipelineRoutes } = await import('../src/routes/pipeline.js');

  const app = Fastify({ logger: false });
  await app.register(replyFrom);
  await app.register(requestIdPlugin);
  await app.register(authPlugin);

  mockVerify.mockReturnValue({
    sub: 'user-1',
    role,
    locations: [],
    must_change_password: false,
  });

  await app.register(pipelineRoutes, { prefix: '/v1/pipeline' });
  await app.ready();
  return app;
}

function makeAuth(role: string): string {
  return `Bearer ${makeJwt({ sub: 'u1', role, locations: [], must_change_password: false })}`;
}

describe('pipeline route', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(mockResponse(200, jwksMock));
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // -------------------------------------------------------------------------
  // Override RBAC — POST /transitions with override: true
  // -------------------------------------------------------------------------
  it('override: true + call_center_manager → 200 forwarded', async () => {
    app = await buildApp('call_center_manager');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pipeline/transitions',
      headers: { Authorization: makeAuth('call_center_manager'), 'Content-Type': 'application/json' },
      payload: JSON.stringify({ override: true, stage: 'contacted' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ proxied: true });
  });

  it('override: true + marketing_manager → 200 forwarded', async () => {
    app = await buildApp('marketing_manager');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pipeline/transitions',
      headers: { Authorization: makeAuth('marketing_manager'), 'Content-Type': 'application/json' },
      payload: JSON.stringify({ override: true }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('override: true + super_admin → 200 forwarded', async () => {
    app = await buildApp('super_admin');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pipeline/transitions',
      headers: { Authorization: makeAuth('super_admin'), 'Content-Type': 'application/json' },
      payload: JSON.stringify({ override: true }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('override: true + call_center_agent → 403 forbidden', async () => {
    app = await buildApp('call_center_agent');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pipeline/transitions',
      headers: { Authorization: makeAuth('call_center_agent'), 'Content-Type': 'application/json' },
      payload: JSON.stringify({ override: true }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
  });

  it('override: true + marketing_staff → 403 forbidden', async () => {
    app = await buildApp('marketing_staff');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pipeline/transitions',
      headers: { Authorization: makeAuth('marketing_staff'), 'Content-Type': 'application/json' },
      payload: JSON.stringify({ override: true }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
  });

  it('override: false → forwarded without RBAC check (any role)', async () => {
    app = await buildApp('call_center_agent');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pipeline/transitions',
      headers: { Authorization: makeAuth('call_center_agent'), 'Content-Type': 'application/json' },
      payload: JSON.stringify({ override: false, stage: 'contacted' }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('override absent → forwarded without RBAC check', async () => {
    app = await buildApp('call_center_agent');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pipeline/transitions',
      headers: { Authorization: makeAuth('call_center_agent'), 'Content-Type': 'application/json' },
      payload: JSON.stringify({ stage: 'contacted' }),
    });
    expect(res.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Channel resolution — POST /convert
  // -------------------------------------------------------------------------
  it('convert happy path: resolved channel overwrites client-supplied value', async () => {
    mockResolveChannel.mockResolvedValue({ ok: true, channel: 'google_ads' });
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pipeline/convert',
      headers: { Authorization: makeAuth('call_center_agent'), 'Content-Type': 'application/json' },
      payload: JSON.stringify({ lead_id: 'lead-123', channel: 'facebook' }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { forwardedBody: { channel: string } };
    expect(body.forwardedBody.channel).toBe('google_ads'); // gateway-resolved value
  });

  it('convert: client-supplied channel overwritten by gateway-resolved value', async () => {
    mockResolveChannel.mockResolvedValue({ ok: true, channel: 'website' });
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pipeline/convert',
      headers: { Authorization: makeAuth('call_center_agent'), 'Content-Type': 'application/json' },
      payload: JSON.stringify({ lead_id: 'lead-abc', channel: 'spoofed_channel' }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { forwardedBody: { channel: string } };
    expect(body.forwardedBody.channel).toBe('website');
  });

  it('convert: Lead Service 404 → 404 lead_not_found, not forwarded', async () => {
    mockResolveChannel.mockResolvedValue({ ok: false, error: 'lead_not_found' });
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pipeline/convert',
      headers: { Authorization: makeAuth('call_center_agent'), 'Content-Type': 'application/json' },
      payload: JSON.stringify({ lead_id: 'missing-lead' }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'lead_not_found' });
  });

  it('convert: Lead Service 500 → 502 upstream_unavailable, not forwarded', async () => {
    mockResolveChannel.mockResolvedValue({ ok: false, error: 'upstream_unavailable' });
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pipeline/convert',
      headers: { Authorization: makeAuth('call_center_agent'), 'Content-Type': 'application/json' },
      payload: JSON.stringify({ lead_id: 'lead-x' }),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'upstream_unavailable' });
  });

  it('convert: Lead Service unreachable/timeout → 502, not forwarded', async () => {
    mockResolveChannel.mockResolvedValue({ ok: false, error: 'upstream_unavailable' });
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pipeline/convert',
      headers: { Authorization: makeAuth('call_center_agent'), 'Content-Type': 'application/json' },
      payload: JSON.stringify({ lead_id: 'lead-timeout' }),
    });
    expect(res.statusCode).toBe(502);
  });

  it('convert: channel null → 422 channel_resolution_failed', async () => {
    mockResolveChannel.mockResolvedValue({ ok: false, error: 'channel_resolution_failed' });
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pipeline/convert',
      headers: { Authorization: makeAuth('call_center_agent'), 'Content-Type': 'application/json' },
      payload: JSON.stringify({ lead_id: 'lead-bad-channel' }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'channel_resolution_failed' });
  });

  it('convert: invalid enum channel → 422 channel_resolution_failed', async () => {
    mockResolveChannel.mockResolvedValue({ ok: false, error: 'channel_resolution_failed' });
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pipeline/convert',
      headers: { Authorization: makeAuth('call_center_agent'), 'Content-Type': 'application/json' },
      payload: JSON.stringify({ lead_id: 'lead-invalid' }),
    });
    expect(res.statusCode).toBe(422);
  });

  it('convert: malformed JSON body → 400', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pipeline/convert',
      headers: { Authorization: makeAuth('call_center_agent'), 'Content-Type': 'application/json' },
      payload: 'not-valid-json',
    });
    expect(res.statusCode).toBe(400);
  });
});
