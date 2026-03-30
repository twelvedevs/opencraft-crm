import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RateLimiter } from '../../src/services/rate-limiter.js';
import type { Redis } from 'ioredis';

describe('RateLimiter', () => {
  let mockRedis: { eval: ReturnType<typeof vi.fn> };
  let rateLimiter: RateLimiter;

  beforeEach(() => {
    mockRedis = { eval: vi.fn() };
    rateLimiter = new RateLimiter(mockRedis as unknown as Redis);
  });

  it('allows the first call', async () => {
    mockRedis.eval.mockResolvedValueOnce([1, 60]);
    const result = await rateLimiter.checkAndIncrement('location:loc-1:inbound_sms');
    expect(result.allowed).toBe(true);
    expect(result.retryAfterSeconds).toBeUndefined();
  });

  it('uses Redis key ratelimit:channel:{channel}', async () => {
    mockRedis.eval.mockResolvedValueOnce([1, 60]);
    await rateLimiter.checkAndIncrement('location:loc-1:inbound_sms');
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'ratelimit:channel:location:loc-1:inbound_sms',
    );
  });

  it('allows exactly 100 calls (boundary)', async () => {
    mockRedis.eval.mockResolvedValueOnce([100, 30]);
    const result = await rateLimiter.checkAndIncrement('location:loc-1:inbound_sms');
    expect(result.allowed).toBe(true);
    expect(result.retryAfterSeconds).toBeUndefined();
  });

  it('rejects the 101st call and returns retryAfterSeconds', async () => {
    mockRedis.eval.mockResolvedValueOnce([101, 45]);
    const result = await rateLimiter.checkAndIncrement('location:loc-1:inbound_sms');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(45);
  });

  it('rejects calls well beyond the limit', async () => {
    mockRedis.eval.mockResolvedValueOnce([150, 10]);
    const result = await rateLimiter.checkAndIncrement('global:system');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(10);
  });

  it('allows again after window expires (counter resets to 1)', async () => {
    // After TTL expires the key is gone; INCR recreates it with count=1
    mockRedis.eval.mockResolvedValueOnce([1, 60]);
    const result = await rateLimiter.checkAndIncrement('location:loc-1:inbound_sms');
    expect(result.allowed).toBe(true);
    expect(result.retryAfterSeconds).toBeUndefined();
  });

  it('uses a Lua script string (not a plain INCR call)', async () => {
    mockRedis.eval.mockResolvedValueOnce([1, 60]);
    await rateLimiter.checkAndIncrement('user:u1:task');
    const [script] = mockRedis.eval.mock.calls[0] as [string, ...unknown[]];
    // The script must reference INCR and EXPIRE — proving atomicity is attempted
    expect(script).toContain('INCR');
    expect(script).toContain('EXPIRE');
  });

  it('works for user channel keys', async () => {
    mockRedis.eval.mockResolvedValueOnce([50, 45]);
    const result = await rateLimiter.checkAndIncrement('user:u1:task');
    expect(result.allowed).toBe(true);
  });
});
