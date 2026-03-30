import { LRUCache } from 'lru-cache';

export interface CachedTemplateContent {
  channel: 'sms' | 'email';
  body_text: string | null;
  subject: string | null;
  body_html: string | null;
}

function cacheKey(id: string): string {
  return `template:${id}:active`;
}

export interface TemplateCacheHandle {
  get(id: string): CachedTemplateContent | undefined;
  set(id: string, content: CachedTemplateContent): void;
  evict(id: string): void;
}

export function createTemplateCache(ttl = 30_000): TemplateCacheHandle {
  const cache = new LRUCache<string, CachedTemplateContent>({ max: 500, ttl });
  return {
    get(id: string) {
      return cache.get(cacheKey(id));
    },
    set(id: string, content: CachedTemplateContent) {
      cache.set(cacheKey(id), content);
    },
    evict(id: string) {
      cache.delete(cacheKey(id));
    },
  };
}

export const templateCache: TemplateCacheHandle = createTemplateCache();
