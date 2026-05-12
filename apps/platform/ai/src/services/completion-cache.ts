import { createHash } from 'node:crypto';
import { LRUCache } from 'lru-cache';
import type { CompletionsRepository } from '../repositories/completions.js';

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function computeCacheKey(promptId: string, model: string, context: unknown): string {
  const payload = promptId + ':' + model + ':' + JSON.stringify(sortKeys(context));
  return createHash('sha256').update(payload).digest('hex');
}

export interface CompletionCacheResult {
  text: string;
  cached: boolean;
}

export interface CompletionCache {
  get(key: string): Promise<CompletionCacheResult | null>;
  set(key: string, text: string, promptId: string, model: string): void;
}

export function createCompletionCache(repo: CompletionsRepository): CompletionCache {
  const l1 = new LRUCache<string, string>({ max: 500, ttl: 60_000 });

  return {
    async get(key: string): Promise<CompletionCacheResult | null> {
      // Check L1
      const l1Hit = l1.get(key);
      if (l1Hit !== undefined) {
        return { text: l1Hit, cached: true };
      }

      // Check L2
      const l2Hit = await repo.findByKey(key);
      if (l2Hit) {
        l1.set(key, l2Hit.response_text);
        return { text: l2Hit.response_text, cached: true };
      }

      return null;
    },

    set(key: string, text: string, promptId: string, model: string): void {
      // Populate L1
      l1.set(key, text);

      // Write to L2 (fire-and-forget)
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      void repo.upsert({
        cache_key: key,
        prompt_id: promptId,
        model,
        response_text: text,
        expires_at: expiresAt,
      });

      // Lazy cleanup (fire-and-forget)
      void repo.deleteExpired();
    },
  };
}
