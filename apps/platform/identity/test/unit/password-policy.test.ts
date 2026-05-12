import { describe, it, expect, beforeEach } from 'vitest';

// password-policy reads env at module load, so we rely on defaults (min 12, all rules true)
// We import it directly since the defaults match our test expectations
import { validatePassword } from '../../src/lib/password-policy.js';

describe('validatePassword', () => {
  it('returns valid for a strong password', () => {
    const result = validatePassword('StrongPass1!xy');
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('fails on empty string with all rule violations', () => {
    const result = validatePassword('');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('minimum 12 characters required');
    expect(result.errors).toContain('at least one uppercase letter required');
    expect(result.errors).toContain('at least one lowercase letter required');
    expect(result.errors).toContain('at least one digit required');
    expect(result.errors).toContain('at least one special character required');
    expect(result.errors).toHaveLength(5);
  });

  it('fails when too short', () => {
    const result = validatePassword('Short1!a');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('minimum 12 characters required');
  });

  it('passes at exactly minimum length', () => {
    const result = validatePassword('Abcdefghij1!'); // 12 chars
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('fails when missing uppercase', () => {
    const result = validatePassword('alllowercase1!');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('at least one uppercase letter required');
    expect(result.errors).toHaveLength(1);
  });

  it('fails when missing lowercase', () => {
    const result = validatePassword('ALLUPPERCASE1!');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('at least one lowercase letter required');
    expect(result.errors).toHaveLength(1);
  });

  it('fails when missing digit', () => {
    const result = validatePassword('NoDigitsHere!x');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('at least one digit required');
    expect(result.errors).toHaveLength(1);
  });

  it('fails when missing special character', () => {
    const result = validatePassword('NoSpecial1abcd');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('at least one special character required');
    expect(result.errors).toHaveLength(1);
  });

  it('accepts non-alphanumeric chars as special', () => {
    // Various special characters should all be accepted
    for (const special of ['!', '@', '#', '$', '%', '^', '&', '*', '-', '_', '.']) {
      const result = validatePassword(`Abcdefghij1${special}`);
      expect(result.valid).toBe(true);
    }
  });

  it('returns multiple errors for multiple violations', () => {
    const result = validatePassword('short'); // short, no uppercase, no digit, no special
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});
