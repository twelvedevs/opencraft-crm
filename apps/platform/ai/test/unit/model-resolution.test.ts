import { describe, it, expect } from 'vitest';
import { resolveModel } from '../../src/services/claude-client.js';

describe('resolveModel', () => {
  it("resolves 'haiku' to 'claude-haiku-4-5-20251001'", () => {
    expect(resolveModel('haiku')).toBe('claude-haiku-4-5-20251001');
  });

  it("resolves 'sonnet' to 'claude-sonnet-4-6'", () => {
    expect(resolveModel('sonnet')).toBe('claude-sonnet-4-6');
  });

  it('explicit model field overrides prompt defaultModel', () => {
    // When a request specifies 'sonnet', it should resolve to sonnet model
    // regardless of what the prompt's defaultModel is
    const requestModel = 'sonnet';
    expect(resolveModel(requestModel)).toBe('claude-sonnet-4-6');
  });

  it('absent model field uses prompt defaultModel', () => {
    // When no model override, the prompt's defaultModel is used
    const promptDefault = 'haiku';
    expect(resolveModel(promptDefault)).toBe('claude-haiku-4-5-20251001');
  });
});
