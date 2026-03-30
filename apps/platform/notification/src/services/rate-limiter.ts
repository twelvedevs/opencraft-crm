import type { Redis } from 'ioredis';

const RATE_LIMIT = 100;
const WINDOW_SECONDS = 60;

/**
 * Atomic Lua script: increments the counter key and sets a 60s TTL only on
 * the first increment (to avoid resetting the window on every call).
 * Returns [count, ttl] where ttl is the remaining window seconds.
 */
const LUA_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ${WINDOW_SECONDS})
  return {current, ${WINDOW_SECONDS}}
end
local ttl = redis.call('TTL', KEYS[1])
return {current, ttl}
`;

export class RateLimiter {
  constructor(private readonly redis: Redis) {}

  async checkAndIncrement(
    channel: string,
  ): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
    const key = `ratelimit:channel:${channel}`;
    const [count, ttl] = (await this.redis.eval(LUA_SCRIPT, 1, key)) as [number, number];

    if (count > RATE_LIMIT) {
      return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : WINDOW_SECONDS };
    }

    return { allowed: true };
  }
}
