import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mock env before importing app
vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5432/test');
vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
vi.stubEnv('BULLMQ_REDIS_URL', 'redis://localhost:6379');
vi.stubEnv('EVENT_BUS_NAME', 'test-bus');
vi.stubEnv('EVENT_BUS_DRIVER', 'mock');
vi.stubEnv('INTERNAL_API_KEY', 'test-key');
vi.stubEnv('MESSAGING_SERVICE_URL', 'http://localhost:3001');
vi.stubEnv('LEAD_SERVICE_URL', 'http://localhost:3000');
vi.stubEnv('AI_SERVICE_URL', 'http://localhost:3002');
vi.stubEnv('AUDIENCE_ENGINE_URL', 'http://localhost:3003');
vi.stubEnv('NOTIFICATION_SERVICE_URL', 'http://localhost:3004');

import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { MockDriver, EventBusImpl } from '@ortho/event-bus';

let app: FastifyInstance;

beforeAll(async () => {
  const { buildApp } = await import('../../src/app.js');
  const driver = new MockDriver();
  const eventBus = new EventBusImpl(driver);
  const mockDb = {} as Knex;
  app = await buildApp(mockDb, eventBus);
});

describe('health endpoint', () => {
  it('returns 200 { ok: true } without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe('internal auth', () => {
  it('returns 401 when X-Internal-Api-Key is absent', async () => {
    const res = await app.inject({ method: 'POST', url: '/conversations' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns 401 when X-Internal-Api-Key is wrong', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/conversations',
      headers: { 'x-internal-api-key': 'wrong-key' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('passes auth with correct key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/conversations/bulk-sends',
      headers: { 'x-internal-api-key': 'test-key' },
    });
    // 501 means auth passed, route stub returned not_implemented
    expect(res.statusCode).toBe(501);
  });
});
