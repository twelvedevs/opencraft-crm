import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

/* ------------------------------------------------------------------ */
/*  Mocks — must come before any app imports                           */
/* ------------------------------------------------------------------ */

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

vi.mock('@anthropic-ai/sdk/error', () => {
  class RateLimitError extends Error {
    status = 429;
    constructor(
      _status: number,
      _error: unknown,
      message: string,
      _headers: Record<string, string>,
    ) {
      super(message);
      this.name = 'RateLimitError';
    }
  }
  class InternalServerError extends Error {
    status: number;
    constructor(
      status: number,
      _error: unknown,
      message: string,
      _headers: Record<string, string>,
    ) {
      super(message);
      this.name = 'InternalServerError';
      this.status = status;
    }
  }
  class APIError extends Error {
    status: number | undefined;
    constructor(
      status: number | undefined,
      _error: unknown,
      message: string,
      _headers: Record<string, string>,
    ) {
      super(message);
      this.name = 'APIError';
      this.status = status;
    }
  }
  return { RateLimitError, InternalServerError, APIError };
});

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: (_name: string, fn: (span: unknown) => unknown) => {
        const span = { setAttribute: vi.fn(), end: vi.fn() };
        return fn(span);
      },
    }),
  },
}));

vi.mock('@ortho/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@arizeai/openinference-instrumentation-anthropic', () => ({
  AnthropicInstrumentation: class {},
}));

vi.mock('@opentelemetry/instrumentation', () => ({
  registerInstrumentations: vi.fn(),
}));

import { buildApp } from '../../src/app.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const DB_URL = process.env['DATABASE_URL'];
const canRunIntegration = !!DB_URL;

function claudeResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

/* ------------------------------------------------------------------ */
/*  Test suite                                                         */
/* ------------------------------------------------------------------ */

describe.skipIf(!canRunIntegration)('POST /ai/complete — integration', () => {
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: DB_URL,
      options: '-c search_path=platform_ai',
    });

    // Run migration via raw SQL
    await pool.query('CREATE SCHEMA IF NOT EXISTS platform_ai');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_ai.ai_completions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        cache_key text NOT NULL UNIQUE,
        prompt_id text NOT NULL,
        model text NOT NULL,
        response_text text NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ai_completions_expires_at_idx
      ON platform_ai.ai_completions (expires_at)
    `);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(claudeResponse('Hello from Claude'));

    // Clean table between tests
    await pool.query('DELETE FROM ai_completions');
  });

  async function freshApp(): Promise<FastifyInstance> {
    const a = await buildApp(pool);
    await a.ready();
    return a;
  }

  /* ------ Health ------ */

  it('GET /health → 200 { status: "ok" }', async () => {
    app = await freshApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  /* ------ Happy path ------ */

  it('valid request → 200 with text, model, prompt_id, cached: false, structured: false', async () => {
    app = await freshApp();
    const res = await app.inject({
      method: 'POST',
      url: '/ai/complete',
      payload: {
        prompt_id: 'smart-reply-draft',
        context: { lead_name: 'Alice' },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.text).toBe('Hello from Claude');
    expect(body.model).toBe('haiku');
    expect(body.prompt_id).toBe('smart-reply-draft');
    expect(body.cached).toBe(false);
    expect(body.structured).toBe(false);
    expect(mockCreate).toHaveBeenCalledOnce();
    await app.close();
  });

  it('conversation-agent-reply prompt → 200 with structured: true', async () => {
    app = await freshApp();
    const res = await app.inject({
      method: 'POST',
      url: '/ai/complete',
      payload: {
        prompt_id: 'conversation-agent-reply',
        context: { message: 'Hi' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().structured).toBe(true);
    await app.close();
  });

  /* ------ Validation errors ------ */

  it('unknown prompt_id → 404', async () => {
    app = await freshApp();
    const res = await app.inject({
      method: 'POST',
      url: '/ai/complete',
      payload: { prompt_id: 'nonexistent', context: {} },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Prompt not found');
    await app.close();
  });

  it('missing context → 400', async () => {
    app = await freshApp();
    const res = await app.inject({
      method: 'POST',
      url: '/ai/complete',
      payload: { prompt_id: 'smart-reply-draft' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('missing prompt_id → 400', async () => {
    app = await freshApp();
    const res = await app.inject({
      method: 'POST',
      url: '/ai/complete',
      payload: { context: {} },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('context is null → 400', async () => {
    app = await freshApp();
    const res = await app.inject({
      method: 'POST',
      url: '/ai/complete',
      payload: { prompt_id: 'smart-reply-draft', context: null },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('context is a string → 400', async () => {
    app = await freshApp();
    const res = await app.inject({
      method: 'POST',
      url: '/ai/complete',
      payload: { prompt_id: 'smart-reply-draft', context: 'hello' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('context is a number → 400', async () => {
    app = await freshApp();
    const res = await app.inject({
      method: 'POST',
      url: '/ai/complete',
      payload: { prompt_id: 'smart-reply-draft', context: 42 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('context: [] (empty array) → 200', async () => {
    app = await freshApp();
    const res = await app.inject({
      method: 'POST',
      url: '/ai/complete',
      payload: { prompt_id: 'smart-reply-draft', context: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cached).toBe(false);
    await app.close();
  });

  it('invalid model value → 400', async () => {
    app = await freshApp();
    const res = await app.inject({
      method: 'POST',
      url: '/ai/complete',
      payload: {
        prompt_id: 'smart-reply-draft',
        context: {},
        model: 'gpt-4',
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  /* ------ Caching ------ */

  it('L1 cache hit on second identical request → Claude not called, cached: true', async () => {
    app = await freshApp();

    // First request — cache miss
    await app.inject({
      method: 'POST',
      url: '/ai/complete',
      payload: { prompt_id: 'smart-reply-draft', context: { key: 'l1test' } },
    });
    expect(mockCreate).toHaveBeenCalledOnce();

    // Second identical request — L1 hit
    const res = await app.inject({
      method: 'POST',
      url: '/ai/complete',
      payload: { prompt_id: 'smart-reply-draft', context: { key: 'l1test' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cached).toBe(true);
    expect(mockCreate).toHaveBeenCalledOnce(); // Still once — not called again

    await app.close();
  });

  it('L2 cache hit (L1 cleared) → Claude not called, cached: true', async () => {
    // First app — populate L2
    const app1 = await freshApp();
    await app1.inject({
      method: 'POST',
      url: '/ai/complete',
      payload: { prompt_id: 'smart-reply-draft', context: { key: 'l2test' } },
    });
    expect(mockCreate).toHaveBeenCalledOnce();
    // Wait for fire-and-forget L2 write to complete
    await new Promise((r) => setTimeout(r, 100));
    await app1.close();

    // Second app — fresh L1, same pool (L2 persisted)
    mockCreate.mockClear();
    const app2 = await freshApp();
    const res = await app2.inject({
      method: 'POST',
      url: '/ai/complete',
      payload: { prompt_id: 'smart-reply-draft', context: { key: 'l2test' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cached).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();

    await app2.close();
  });

  it('expired L2 entry → Claude called again, fresh entry written', async () => {
    // Insert expired L2 entry directly
    const { computeCacheKey } = await import('../../src/services/completion-cache.js');
    const cacheKey = computeCacheKey('smart-reply-draft', 'haiku', { key: 'expired' });

    await pool.query(
      `INSERT INTO ai_completions (cache_key, prompt_id, model, response_text, expires_at)
       VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 minute')
       ON CONFLICT (cache_key) DO UPDATE
       SET response_text = EXCLUDED.response_text, expires_at = EXCLUDED.expires_at`,
      [cacheKey, 'smart-reply-draft', 'haiku', 'stale response'],
    );

    app = await freshApp();
    const res = await app.inject({
      method: 'POST',
      url: '/ai/complete',
      payload: { prompt_id: 'smart-reply-draft', context: { key: 'expired' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cached).toBe(false);
    expect(res.json().text).toBe('Hello from Claude');
    expect(mockCreate).toHaveBeenCalledOnce();

    await app.close();
  });

  /* ------ Claude error handling ------ */

  it('Claude throws RateLimitError → 503', async () => {
    const { RateLimitError } = await import('@anthropic-ai/sdk/error');
    mockCreate.mockRejectedValueOnce(
      new RateLimitError(429, {}, 'Rate limited', {}),
    );

    app = await freshApp();
    const res = await app.inject({
      method: 'POST',
      url: '/ai/complete',
      payload: { prompt_id: 'smart-reply-draft', context: { key: 'rate' } },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('Claude API unavailable');
    await app.close();
  });

  it('Claude throws APIStatusError with status 529 → 503', async () => {
    const { InternalServerError } = await import('@anthropic-ai/sdk/error');
    mockCreate.mockRejectedValueOnce(
      new InternalServerError(529, {}, 'Overloaded', {}),
    );

    app = await freshApp();
    const res = await app.inject({
      method: 'POST',
      url: '/ai/complete',
      payload: { prompt_id: 'smart-reply-draft', context: { key: '529' } },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('Claude API unavailable');
    await app.close();
  });

  it('Claude throws APIStatusError with status 500 → 503', async () => {
    const { InternalServerError } = await import('@anthropic-ai/sdk/error');
    mockCreate.mockRejectedValueOnce(
      new InternalServerError(500, {}, 'Internal error', {}),
    );

    app = await freshApp();
    const res = await app.inject({
      method: 'POST',
      url: '/ai/complete',
      payload: { prompt_id: 'smart-reply-draft', context: { key: '500' } },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('Claude API unavailable');
    await app.close();
  });

  /* ------ L2 write failure ------ */

  it('L2 write error → response still returned to caller', async () => {
    app = await freshApp();

    // Temporarily break pool.query for INSERT operations
    const origQuery = pool.query.bind(pool);
    const querySpy = vi.spyOn(pool, 'query').mockImplementation(
      (async (...args: unknown[]) => {
        const sql = typeof args[0] === 'string' ? args[0] : '';
        if (sql.includes('INSERT INTO ai_completions')) {
          throw new Error('Simulated PG write failure');
        }
        return (origQuery as Function)(...args);
      }) as typeof pool.query,
    );

    const res = await app.inject({
      method: 'POST',
      url: '/ai/complete',
      payload: { prompt_id: 'smart-reply-draft', context: { key: 'write-fail' } },
    });

    // Response should still succeed — L2 write is fire-and-forget
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBe('Hello from Claude');
    expect(res.json().cached).toBe(false);

    // Wait for async error to surface
    await new Promise((r) => setTimeout(r, 100));

    querySpy.mockRestore();
    await app.close();
  });

  /* ------ Lazy cleanup ------ */

  it('write with expired rows → expired rows deleted after write', async () => {
    // Insert expired row (expired > 1 hour ago for deleteExpired criteria)
    await pool.query(
      `INSERT INTO ai_completions (cache_key, prompt_id, model, response_text, expires_at)
       VALUES ($1, $2, $3, $4, NOW() - INTERVAL '2 hours')`,
      ['expired-row-key', 'smart-reply-draft', 'haiku', 'old response'],
    );

    // Verify expired row exists
    const before = await pool.query(
      "SELECT * FROM ai_completions WHERE cache_key = 'expired-row-key'",
    );
    expect(before.rows).toHaveLength(1);

    app = await freshApp();

    // Make a request that triggers cache set (and thus lazy cleanup)
    await app.inject({
      method: 'POST',
      url: '/ai/complete',
      payload: { prompt_id: 'smart-reply-draft', context: { key: 'cleanup-trigger' } },
    });

    // Wait for fire-and-forget cleanup
    await new Promise((r) => setTimeout(r, 200));

    // Verify expired row was cleaned up
    const after = await pool.query(
      "SELECT * FROM ai_completions WHERE cache_key = 'expired-row-key'",
    );
    expect(after.rows).toHaveLength(0);

    await app.close();
  });
});
