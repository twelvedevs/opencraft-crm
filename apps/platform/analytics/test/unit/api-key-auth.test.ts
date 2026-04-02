import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify from 'fastify';
import { apiKeyAuthPlugin } from '../../src/plugins/api-key-auth.js';

// Set env vars read directly by the plugin's onRequest hook
beforeAll(() => {
  process.env['IDENTITY_SERVICE_URL'] = 'http://identity:3001';
  process.env['API_KEY_CACHE_TTL_SECONDS'] = '60';
});

afterAll(() => {
  delete process.env['IDENTITY_SERVICE_URL'];
  delete process.env['API_KEY_CACHE_TTL_SECONDS'];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // Restore default TTL in case a test changed it
  process.env['API_KEY_CACHE_TTL_SECONDS'] = '60';
});

/** Build a Fastify app with the plugin registered and a test route that echoes injected headers. */
async function makeApp() {
  const app = Fastify({ logger: false });
  await app.register(apiKeyAuthPlugin);
  app.get('/test', async (request) => ({
    ok: true,
    role: request.headers['x-user-role'] ?? null,
    perms: request.headers['x-api-key-permissions'] ?? null,
  }));
  return app;
}

function stubFetchOk(role = 'admin', permissions = 'read,write') {
  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ role, permissions }),
  });
  vi.stubGlobal('fetch', mockFetch);
  return mockFetch;
}

describe('apiKeyAuthPlugin', () => {
  it('first call with ak_ key hits Identity Service and caches result', async () => {
    // Each test uses a unique API key to avoid cross-test cache hits
    const mockFetch = stubFetchOk();
    const app = await makeApp();

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: 'ak_unique-first-call-test' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0]! as [string, unknown];
    expect(url).toContain('/identity/api-keys/validate');
  });

  it('second call with same key uses cache — Identity Service called only once', async () => {
    const mockFetch = stubFetchOk();
    const app = await makeApp();
    const apiKey = 'ak_cache-reuse-unique-test';

    // First request — cache miss
    const res1 = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: apiKey },
    });
    expect(res1.statusCode).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();

    // Second request — cache hit, no additional Identity Service call
    const res2 = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: apiKey },
    });
    expect(res2.statusCode).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce(); // still only once
  });

  it('TTL expiry causes re-validation on subsequent request', async () => {
    vi.useFakeTimers();
    process.env['API_KEY_CACHE_TTL_SECONDS'] = '1';
    const mockFetch = stubFetchOk();
    const app = await makeApp();
    const apiKey = 'ak_ttl-expiry-unique-test';

    // First request — cache miss
    await app.inject({ method: 'GET', url: '/test', headers: { authorization: apiKey } });
    expect(mockFetch).toHaveBeenCalledOnce();

    // Advance time past 1-second TTL
    vi.setSystemTime(Date.now() + 2000);

    // Second request — cache entry expired, Identity Service called again
    await app.inject({ method: 'GET', url: '/test', headers: { authorization: apiKey } });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('non-ak_ Authorization header bypasses plugin without calling Identity Service', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const app = await makeApp();

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.some-jwt' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('request with no Authorization header bypasses plugin', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const app = await makeApp();

    const res = await app.inject({ method: 'GET', url: '/test' });

    expect(res.statusCode).toBe(200);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('Identity Service 401 response returns 401 to client', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }),
    );
    const app = await makeApp();

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: 'ak_invalid-key-unique-test' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('network error from Identity Service returns 401 to client', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const app = await makeApp();

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: 'ak_network-error-unique-test' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('injects X-User-Role and X-Api-Key-Permissions headers after successful validation', async () => {
    stubFetchOk('marketing_staff', 'analytics:read');
    const app = await makeApp();

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { authorization: 'ak_header-inject-unique-test' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('marketing_staff');
    expect(res.json().perms).toBe('analytics:read');
  });
});
