import { describe, expect, it } from 'vitest';
import { assignVariant } from '../../src/services/ab-assigner.js';

describe('assignVariant', () => {
  it('returns null for null', () => {
    expect(assignVariant(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(assignVariant(undefined)).toBeNull();
  });

  it('returns null when enabled is false', () => {
    expect(assignVariant({ enabled: false, split: { A: 50, B: 50 } })).toBeNull();
  });

  it('always returns A when B weight is 0 (100 samples)', () => {
    const results = Array.from({ length: 100 }, () =>
      assignVariant({ enabled: true, split: { A: 100, B: 0 } })
    );
    expect(results.every((r) => r === 'A')).toBe(true);
  });

  it('always returns B when A weight is 0 (100 samples)', () => {
    const results = Array.from({ length: 100 }, () =>
      assignVariant({ enabled: true, split: { A: 0, B: 100 } })
    );
    expect(results.every((r) => r === 'B')).toBe(true);
  });

  it('distributes 50/50 split roughly evenly over 10000 samples', () => {
    const counts: Record<string, number> = { A: 0, B: 0 };
    for (let i = 0; i < 10000; i++) {
      const v = assignVariant({ enabled: true, split: { A: 50, B: 50 } });
      if (v !== null) counts[v] = (counts[v] ?? 0) + 1;
    }
    expect(counts['A']).toBeGreaterThan(4000);
    expect(counts['A']).toBeLessThan(6000);
    expect(counts['B']).toBeGreaterThan(4000);
    expect(counts['B']).toBeLessThan(6000);
  });
});
