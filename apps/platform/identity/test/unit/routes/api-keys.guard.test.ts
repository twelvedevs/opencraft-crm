import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Mock env before any imports that pull in env.ts
vi.mock('../../../src/env.js', () => ({
  env: {
    INTERNAL_API_SECRET: 'test-secret',
    CORS_ORIGIN: ['http://localhost:3000'],
    LOG_LEVEL: 'silent',
  },
}));

vi.mock('@ortho/auth-middleware', () => ({
  requireRole: () => async () => {},
}));

vi.mock('../../../src/services/api-key.service.js', () => ({
  validateApiKey: vi.fn(),
  generateApiKey: vi.fn(),
  listApiKeys: vi.fn().mockResolvedValue([]),
  revokeApiKey: vi.fn(),
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { apiKeysRoutes } from '../../../src/routes/api-keys.js';
import * as apiKeyService from '../../../src/services/api-key.service.js';
import type { Pool } from 'pg';

describe('internalSecretGuard', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(apiKeysRoutes, { pool: {} as Pool });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects with 401 and does not invoke validateApiKey when X-Internal-Secret is missing', async () => {
    vi.mocked(apiKeyService.validateApiKey).mockClear();

    const res = await app.inject({
      method: 'POST',
      url: '/identity/api-keys/validate',
      payload: { key: 'ak_fake_key' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthorized');
    expect(apiKeyService.validateApiKey).not.toHaveBeenCalled();
  });

  it('rejects with 401 and does not invoke validateApiKey when X-Internal-Secret is wrong', async () => {
    vi.mocked(apiKeyService.validateApiKey).mockClear();

    const res = await app.inject({
      method: 'POST',
      url: '/identity/api-keys/validate',
      headers: { 'x-internal-secret': 'wrong-secret' },
      payload: { key: 'ak_fake_key' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unauthorized');
    expect(apiKeyService.validateApiKey).not.toHaveBeenCalled();
  });

  it('invokes validateApiKey when X-Internal-Secret is correct', async () => {
    vi.mocked(apiKeyService.validateApiKey).mockResolvedValue({ permissions: ['leads:read'] });

    const res = await app.inject({
      method: 'POST',
      url: '/identity/api-keys/validate',
      headers: { 'x-internal-secret': 'test-secret' },
      payload: { key: 'ak_real_key' },
    });

    expect(res.statusCode).toBe(200);
    expect(apiKeyService.validateApiKey).toHaveBeenCalledOnce();
  });
});
