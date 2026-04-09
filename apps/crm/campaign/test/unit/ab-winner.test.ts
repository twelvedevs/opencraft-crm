import { describe, it, expect } from 'vitest';
import { selectWinner } from '../../src/services/ab-winner.js';

describe('selectWinner', () => {
  it('returns A when A has higher open rate', () => {
    expect(selectWinner(50, 100, 30, 100)).toBe('A');
  });

  it('returns B when B has higher open rate', () => {
    expect(selectWinner(30, 100, 50, 100)).toBe('B');
  });

  it('returns A on tie (ties go to A)', () => {
    expect(selectWinner(50, 100, 50, 100)).toBe('A');
  });

  it('returns A when both counts are zero (degenerate case)', () => {
    expect(selectWinner(0, 0, 0, 0)).toBe('A');
  });

  it('returns B when countA=0 and B has opens', () => {
    expect(selectWinner(0, 0, 10, 50)).toBe('B');
  });

  it('returns A when countB=0 and A has opens', () => {
    expect(selectWinner(10, 50, 0, 0)).toBe('A');
  });
});
