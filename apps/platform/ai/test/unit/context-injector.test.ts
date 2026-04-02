import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@ortho/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { injectContext } from '../../src/services/context-injector.js';

describe('injectContext', () => {
  it('replaces all present tags with correct values', () => {
    const result = injectContext('Hello {{name}}, welcome to {{place}}!', {
      name: 'Alice',
      place: 'Ortho CRM',
    });
    expect(result).toBe('Hello Alice, welcome to Ortho CRM!');
  });

  it('replaces missing key with empty string without throwing', () => {
    const result = injectContext('Hello {{name}}, age {{age}}', { name: 'Bob' });
    expect(result).toBe('Hello Bob, age ');
  });

  it('resolves dot-notation 1 level deep', () => {
    const result = injectContext('{{name}}', { name: 'Alice' });
    expect(result).toBe('Alice');
  });

  it('resolves dot-notation 2 levels deep', () => {
    const result = injectContext('{{lead.name}}', { lead: { name: 'Alice' } });
    expect(result).toBe('Alice');
  });

  it('resolves dot-notation 3 levels deep', () => {
    const result = injectContext('{{lead.address.city}}', {
      lead: { address: { city: 'Portland' } },
    });
    expect(result).toBe('Portland');
  });

  it('treats dot-notation 4+ levels deep as missing (empty string)', () => {
    const result = injectContext('{{a.b.c.d}}', {
      a: { b: { c: { d: 'deep' } } },
    });
    expect(result).toBe('');
  });

  it('replaces multiple occurrences of the same tag', () => {
    const result = injectContext('{{x}} and {{x}} again', { x: 'hi' });
    expect(result).toBe('hi and hi again');
  });

  it('passes through template with no tags unchanged', () => {
    const result = injectContext('No tags here', { key: 'val' });
    expect(result).toBe('No tags here');
  });

  it('converts number values via toString()', () => {
    const result = injectContext('Age: {{age}}', { age: 42 });
    expect(result).toBe('Age: 42');
  });

  it('converts boolean values via toString()', () => {
    const result = injectContext('Active: {{active}}', { active: true });
    expect(result).toBe('Active: true');
  });

  it('converts nested objects to [object Object]', () => {
    const result = injectContext('Data: {{data}}', { data: { nested: true } });
    expect(result).toBe('Data: [object Object]');
  });
});
