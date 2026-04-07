import { describe, it, expect } from 'vitest';
import {
  STAGES,
  isValidTransition,
  computeTimeoutAt,
  getTimeoutStage,
} from '../../src/services/state-machine.js';

describe('isValidTransition', () => {
  // ── Valid transitions ──
  const validPairs: [string, string][] = [
    ['new_lead', 'contacted'],
    ['new_lead', 'lost'],
    ['contacted', 'exam_scheduled'],
    ['contacted', 'lost'],
    ['exam_scheduled', 'exam_completed'],
    ['exam_scheduled', 'contacted'],
    ['exam_completed', 'tx_presented'],
    ['exam_completed', 'lost'],
    ['tx_presented', 'contract_signed'],
    ['tx_presented', 'lost'],
    ['lost', 'contacted'],
    ['new_patient', 'in_treatment'],
    ['in_treatment', 'treatment_complete'],
    ['active_retention', 'recall_due'],
    ['recall_due', 'long_term_follow'],
    ['long_term_follow', 'active_retention'],
  ];

  it.each(validPairs)(
    '%s → %s returns true',
    (from, to) => {
      expect(isValidTransition(from, to, false)).toBe(true);
    },
  );

  // ── Invalid transitions ──
  const invalidPairs: [string, string][] = [
    ['new_lead', 'tx_presented'],
    ['contacted', 'contract_signed'],
    ['exam_scheduled', 'lost'],
    ['contract_signed', 'new_lead'],
    ['treatment_complete', 'in_treatment'],
    ['active_retention', 'long_term_follow'],
  ];

  it.each(invalidPairs)(
    '%s → %s returns false',
    (from, to) => {
      expect(isValidTransition(from, to, false)).toBe(false);
    },
  );

  // ── Override ──
  it('override=true returns true for any pair within a known stage', () => {
    expect(isValidTransition('new_lead', 'tx_presented', true)).toBe(true);
    expect(isValidTransition('contacted', 'contract_signed', true)).toBe(true);
    expect(isValidTransition('active_retention', 'long_term_follow', true)).toBe(true);
  });

  it('override=true with unknown fromStage returns false', () => {
    expect(isValidTransition('nonexistent', 'contacted', true)).toBe(false);
  });

  it('unknown fromStage returns false without throwing', () => {
    expect(isValidTransition('unknown_stage', 'contacted', false)).toBe(false);
  });
});

describe('computeTimeoutAt', () => {
  const enteredAt = new Date('2026-04-01T12:00:00Z');

  it('new_lead (timeoutDays null) → returns null', () => {
    expect(computeTimeoutAt('new_lead', enteredAt)).toBeNull();
  });

  it('contacted (timeoutDays=5) → returns enteredAt + 5 days', () => {
    const result = computeTimeoutAt('contacted', enteredAt);
    expect(result).toEqual(new Date(enteredAt.getTime() + 5 * 86_400_000));
  });

  it('exam_completed (timeoutDays=7) → returns enteredAt + 7 days', () => {
    const result = computeTimeoutAt('exam_completed', enteredAt);
    expect(result).toEqual(new Date(enteredAt.getTime() + 7 * 86_400_000));
  });

  it('tx_presented (timeoutDays=14) → returns enteredAt + 14 days', () => {
    const result = computeTimeoutAt('tx_presented', enteredAt);
    expect(result).toEqual(new Date(enteredAt.getTime() + 14 * 86_400_000));
  });

  it('lost (timeoutDays=30) → returns enteredAt + 30 days', () => {
    const result = computeTimeoutAt('lost', enteredAt);
    expect(result).toEqual(new Date(enteredAt.getTime() + 30 * 86_400_000));
  });

  it('recall_due with callerProvidedTimeoutAt → returns that value', () => {
    const callerTimeout = new Date('2026-06-01T00:00:00Z');
    expect(computeTimeoutAt('recall_due', enteredAt, callerTimeout)).toEqual(callerTimeout);
  });

  it('recall_due without callerProvidedTimeoutAt → returns null', () => {
    expect(computeTimeoutAt('recall_due', enteredAt)).toBeNull();
  });

  it('treatment_complete (no timeout) → returns null', () => {
    expect(computeTimeoutAt('treatment_complete', enteredAt)).toBeNull();
  });

  it('contract_signed (no timeout) → returns null', () => {
    expect(computeTimeoutAt('contract_signed', enteredAt)).toBeNull();
  });

  it('unknown stage → returns null', () => {
    expect(computeTimeoutAt('nonexistent', enteredAt)).toBeNull();
  });
});

describe('getTimeoutStage', () => {
  it('contacted → lost', () => {
    expect(getTimeoutStage('contacted')).toBe('lost');
  });

  it('exam_completed → lost', () => {
    expect(getTimeoutStage('exam_completed')).toBe('lost');
  });

  it('tx_presented → lost', () => {
    expect(getTimeoutStage('tx_presented')).toBe('lost');
  });

  it('lost → null (archive, not a stage transition)', () => {
    expect(getTimeoutStage('lost')).toBeNull();
  });

  it('recall_due → long_term_follow', () => {
    expect(getTimeoutStage('recall_due')).toBe('long_term_follow');
  });

  it('new_lead → null', () => {
    expect(getTimeoutStage('new_lead')).toBeNull();
  });

  it('contract_signed → null', () => {
    expect(getTimeoutStage('contract_signed')).toBeNull();
  });

  it('new_patient → null', () => {
    expect(getTimeoutStage('new_patient')).toBeNull();
  });

  it('unknown stage → null (no throw)', () => {
    expect(getTimeoutStage('nonexistent')).toBeNull();
  });
});
