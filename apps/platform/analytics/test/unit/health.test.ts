import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { healthRoutes } from '../../src/routes/health.js';
import type { Pool } from 'pg';

describe('health routes', () => {
  it('GET /health returns 200 { status: ok }', async () => {
    const app = Fastify();
    const mockPool = { query: vi.fn().mockResolvedValue({}) } as unknown as Pool;
    await app.register(healthRoutes, { pool: mockPool });

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /ready returns 200 when DB is reachable', async () => {
    const app = Fastify();
    const mockPool = { query: vi.fn().mockResolvedValue({}) } as unknown as Pool;
    await app.register(healthRoutes, { pool: mockPool });

    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
  });

  it('GET /ready returns 503 when DB is unreachable', async () => {
    const app = Fastify();
    const mockPool = {
      query: vi.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as Pool;
    await app.register(healthRoutes, { pool: mockPool });

    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'unavailable' });
  });
});
