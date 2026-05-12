import { describe, it, expect } from 'vitest';
import { computeAbSignificance } from '../../src/services/ab-significance.js';

describe('computeAbSignificance', () => {
  it('returns not significant when both variants below 100 enrollments', () => {
    const result = computeAbSignificance(
      { enrollments: 50, conversions: 10 },
      { enrollments: 50, conversions: 8 },
      'A',
      'B',
    );
    expect(result.significant).toBe(false);
    expect(result.winner).toBeNull();
    expect(result.p_value).toBe(1);
  });

  it('returns not significant when variant A below 100 enrollments', () => {
    const result = computeAbSignificance(
      { enrollments: 99, conversions: 20 },
      { enrollments: 200, conversions: 40 },
      'A',
      'B',
    );
    expect(result.significant).toBe(false);
    expect(result.winner).toBeNull();
    expect(result.p_value).toBe(1);
  });

  it('design spec example: p≈0.031, winner A (43/175 vs 27/175 achieves target p-value)', () => {
    // PRD notes cite 42/175 vs 31/175 → p≈0.031 but actual math gives p≈0.148.
    // 43/175 vs 27/175 correctly yields p≈0.032 (< 0.05, significant).
    const result = computeAbSignificance(
      { enrollments: 175, conversions: 43 },
      { enrollments: 175, conversions: 27 },
      'A',
      'B',
    );
    expect(result.significant).toBe(true);
    expect(result.winner).toBe('A');
    expect(result.p_value).toBeCloseTo(0.032, 2);
  });

  it('identical conversion rates → not significant', () => {
    const result = computeAbSignificance(
      { enrollments: 175, conversions: 50 },
      { enrollments: 175, conversions: 50 },
      'A',
      'B',
    );
    expect(result.significant).toBe(false);
    expect(result.winner).toBeNull();
  });

  it('se = 0 edge case (0 conversions in both) → not significant, p_value 1', () => {
    const result = computeAbSignificance(
      { enrollments: 100, conversions: 0 },
      { enrollments: 100, conversions: 0 },
      'A',
      'B',
    );
    expect(result.significant).toBe(false);
    expect(result.winner).toBeNull();
    expect(result.p_value).toBe(1);
  });

  it('exactly 100 enrollments per variant → does not return early', () => {
    // With 100 enrollments each, should proceed to compute (not early return)
    const result = computeAbSignificance(
      { enrollments: 100, conversions: 30 },
      { enrollments: 100, conversions: 10 },
      'A',
      'B',
    );
    // p_value should be well below 1 (i.e., it did not early return)
    expect(result.p_value).toBeLessThan(1);
  });
});
