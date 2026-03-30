import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTemplateCache, templateCache } from '../../src/services/template-cache.js';
import type { CachedTemplateContent } from '../../src/services/template-cache.js';

const sampleContent: CachedTemplateContent = {
  channel: 'sms',
  body_text: 'Hello {{first_name}}',
  subject: null,
  body_html: null,
};

describe('templateCache singleton', () => {
  beforeEach(() => {
    templateCache.evict('test-id');
    templateCache.evict('unknown-id');
  });

  it('cache hit: set then get returns the stored content', () => {
    templateCache.set('test-id', sampleContent);
    const result = templateCache.get('test-id');
    expect(result).toEqual(sampleContent);
  });

  it('cache miss: get on unknown id returns undefined', () => {
    const result = templateCache.get('unknown-id');
    expect(result).toBeUndefined();
  });

  it('evict: set then evict then get returns undefined', () => {
    templateCache.set('test-id', sampleContent);
    templateCache.evict('test-id');
    const result = templateCache.get('test-id');
    expect(result).toBeUndefined();
  });
});

describe('templateCache TTL', () => {
  it(
    'TTL expiry: entry returns undefined after TTL elapses',
    async () => {
      // lru-cache captures the performance reference at module load time,
      // so fake timers cannot advance its internal clock. Use a real short TTL.
      const cache = createTemplateCache(100);
      cache.set('test-id', sampleContent);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const result = cache.get('test-id');
      expect(result).toBeUndefined();
    },
    { timeout: 5000 },
  );
});
