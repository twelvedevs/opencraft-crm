import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import {
  createTestContext,
  makeServiceToken,
  resetSchema,
  type TestContext,
} from './helpers.js';

describe('Rate limiting — 100 req/60s per channel', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    await resetSchema(ctx.db);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    // Flush rate limit keys to ensure a clean window per test
    const keys = await ctx.redis.keys('ratelimit:channel:*');
    if (keys.length > 0) {
      await ctx.redis.del(...keys);
    }
  });

  it('101st publish within 60s returns 429 with Retry-After header', async () => {
    const serviceToken = await makeServiceToken();
    // Use a unique channel per test run so no cross-contamination
    const locId = randomUUID();
    const channel = `location:${locId}:alerts`;

    // Pre-seed Redis counter to 100 (simulates 100 previous requests in the window)
    const rateKey = `ratelimit:channel:${channel}`;
    await ctx.redis.set(rateKey, '100', 'EX', 60);

    // 101st request — should be rate-limited
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/notifications/publish',
      headers: { Authorization: `Bearer ${serviceToken}` },
      body: { channel, title: 'Over limit' },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json<{ error: string }>().error).toBe('rate_limit_exceeded');
    expect(res.headers['retry-after']).toBeTruthy();
    const retryAfter = parseInt(String(res.headers['retry-after']), 10);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it('first 100 requests in a window are allowed', async () => {
    const serviceToken = await makeServiceToken();
    const locId = randomUUID();
    const channel = `location:${locId}:alerts`;

    // Pre-seed to 99 — one more should be allowed
    const rateKey = `ratelimit:channel:${channel}`;
    await ctx.redis.set(rateKey, '99', 'EX', 60);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/notifications/publish',
      headers: { Authorization: `Bearer ${serviceToken}` },
      body: { channel, title: 'Within limit' },
    });

    expect(res.statusCode).toBe(201);
  });
});
