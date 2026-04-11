import { createHash } from 'node:crypto';
import { LRUCache } from 'lru-cache';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface CachedApiKey {
  permissions: string[];
}

// ---------------------------------------------------------------------------
// LRU cache — max 500 entries, TTL from config
// ---------------------------------------------------------------------------
const cache = new LRUCache<string, CachedApiKey>({
  max: 500,
  ttl: config.API_KEY_CACHE_TTL_MS,
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** Compute a SHA-256 hex digest of the raw API key for use as a cache key. */
export function computeKeyHash(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

/** Look up a previously validated API key by its hash. */
export function getFromCache(keyHash: string): CachedApiKey | undefined {
  return cache.get(keyHash);
}

/** Store a validated API key result in the cache. */
export function setInCache(keyHash: string, value: CachedApiKey): void {
  cache.set(keyHash, value);
}

/** Evict all entries — used in tests to reset state between cases. */
export function clearCache(): void {
  cache.clear();
}
