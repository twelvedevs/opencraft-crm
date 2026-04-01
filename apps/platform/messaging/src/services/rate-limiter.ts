import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Redis } from 'ioredis';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class RateLimiter {
  private sha: string | null = null;
  private readonly luaScript: string;

  constructor(private readonly redis: Redis) {
    this.luaScript = readFileSync(join(__dirname, 'rate-limiter.lua'), 'utf-8');
  }

  async init(): Promise<void> {
    this.sha = (await this.redis.script('LOAD', this.luaScript)) as string;
  }

  async tryConsume(
    fromNumber: string,
    rateLimitMps: number,
  ): Promise<{ allowed: boolean; retryAfter?: number }> {
    if (!this.sha) {
      throw new Error('RateLimiter not initialized — call init() first');
    }

    const key = `rate_limit:msg:${fromNumber}`;
    const now = Date.now() * 1000; // microseconds

    const result = await this.redis.evalsha(
      this.sha,
      1,
      key,
      rateLimitMps,
      rateLimitMps,
      now,
    );

    if (result === 1) {
      return { allowed: true };
    }
    return { allowed: false, retryAfter: 1 };
  }
}
