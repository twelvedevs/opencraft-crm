import { describe, it, expect } from 'vitest';
import { computeCacheKey } from '../../src/services/completion-cache.js';

describe('computeCacheKey', () => {
  it('produces the same hash regardless of key insertion order', () => {
    const ctx1 = { b: 2, a: 1 };
    const ctx2 = { a: 1, b: 2 };
    expect(computeCacheKey('p1', 'haiku', ctx1)).toBe(
      computeCacheKey('p1', 'haiku', ctx2)
    );
  });

  it('produces different hash for different context', () => {
    expect(computeCacheKey('p1', 'haiku', { a: 1 })).not.toBe(
      computeCacheKey('p1', 'haiku', { a: 2 })
    );
  });

  it('produces different hash for different prompt_id', () => {
    const ctx = { a: 1 };
    expect(computeCacheKey('p1', 'haiku', ctx)).not.toBe(
      computeCacheKey('p2', 'haiku', ctx)
    );
  });

  it('produces different hash for different model', () => {
    const ctx = { a: 1 };
    expect(computeCacheKey('p1', 'haiku', ctx)).not.toBe(
      computeCacheKey('p1', 'sonnet', ctx)
    );
  });
});
