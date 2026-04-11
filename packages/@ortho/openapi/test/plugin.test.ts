import Fastify from 'fastify';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { openapiPlugin } from '../src/index.js';

describe('openapiPlugin — non-production', () => {
  const app = Fastify();

  beforeAll(async () => {
    await app.register(openapiPlugin, {
      title: 'Test Service',
      description: 'Unit test service',
      tags: [{ name: 'Things', description: 'Things resource' }],
    });
    await app.ready();
  });

  afterAll(() => app.close());

  it('serves Swagger UI at /docs', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('serves OpenAPI spec at /openapi.json', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json() as Record<string, unknown>;
    expect(spec['openapi']).toBe('3.0.0');
  });

  it('configures BearerAuth security scheme', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    const spec = res.json() as {
      components: { securitySchemes: { BearerAuth: { scheme: string } } };
    };
    expect(spec.components.securitySchemes.BearerAuth.scheme).toBe('bearer');
  });

  it('includes provided tags in spec', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    const spec = res.json() as { tags: Array<{ name: string }> };
    expect(spec.tags.some((t) => t.name === 'Things')).toBe(true);
  });
});

describe('openapiPlugin — production', () => {
  const app = Fastify();

  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await app.register(openapiPlugin, { title: 'Test Service' });
    await app.ready();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  it('does not register /docs in production', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' });
    expect(res.statusCode).toBe(404);
  });

  it('does not register /openapi.json in production', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(404);
  });
});
