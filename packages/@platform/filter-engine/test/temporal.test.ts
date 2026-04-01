import { describe, it, expect } from 'vitest';
import { evaluate } from '../src/evaluate.js';
import type { ConditionNode, FilterNode, EvalContext } from '../src/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

describe('temporal operators', () => {
  const now = new Date('2026-03-15T12:00:00.000Z');
  const context: EvalContext = { now };

  describe('within_last', () => {
    it('field exactly N days ago is INCLUDED (boundary inclusive)', () => {
      const fieldDate = new Date(now.getTime() - 5 * DAY_MS).toISOString();
      const node: ConditionNode = {
        field: 'created_at',
        op: 'within_last',
        value: { amount: 5, unit: 'days' },
      };
      expect(evaluate(node, { created_at: fieldDate }, context)).toBe(true);
    });

    it('field N+1 days ago returns false', () => {
      const fieldDate = new Date(now.getTime() - 6 * DAY_MS).toISOString();
      const node: ConditionNode = {
        field: 'created_at',
        op: 'within_last',
        value: { amount: 5, unit: 'days' },
      };
      expect(evaluate(node, { created_at: fieldDate }, context)).toBe(false);
    });

    it('boundary inclusive with hours', () => {
      const fieldDate = new Date(now.getTime() - 3 * HOUR_MS).toISOString();
      const node: ConditionNode = {
        field: 'updated_at',
        op: 'within_last',
        value: { amount: 3, unit: 'hours' },
      };
      expect(evaluate(node, { updated_at: fieldDate }, context)).toBe(true);
    });
  });

  describe('not_within_last', () => {
    it('field N days ago returns false (boundary)', () => {
      const fieldDate = new Date(now.getTime() - 5 * DAY_MS).toISOString();
      const node: ConditionNode = {
        field: 'created_at',
        op: 'not_within_last',
        value: { amount: 5, unit: 'days' },
      };
      expect(evaluate(node, { created_at: fieldDate }, context)).toBe(false);
    });

    it('field N+1 days ago returns true', () => {
      const fieldDate = new Date(now.getTime() - 6 * DAY_MS).toISOString();
      const node: ConditionNode = {
        field: 'created_at',
        op: 'not_within_last',
        value: { amount: 5, unit: 'days' },
      };
      expect(evaluate(node, { created_at: fieldDate }, context)).toBe(true);
    });
  });

  describe('before', () => {
    it('field before date returns true', () => {
      const node: ConditionNode = {
        field: 'created_at',
        op: 'before',
        value: '2026-03-15T00:00:00.000Z',
      };
      expect(evaluate(node, { created_at: '2026-03-14T23:59:59.000Z' }, context)).toBe(true);
    });

    it('field on exact date returns false (strictly less than)', () => {
      const node: ConditionNode = {
        field: 'created_at',
        op: 'before',
        value: '2026-03-15T00:00:00.000Z',
      };
      expect(evaluate(node, { created_at: '2026-03-15T00:00:00.000Z' }, context)).toBe(false);
    });
  });

  describe('after', () => {
    it('field after date returns true', () => {
      const node: ConditionNode = {
        field: 'created_at',
        op: 'after',
        value: '2026-03-15T00:00:00.000Z',
      };
      expect(evaluate(node, { created_at: '2026-03-15T00:00:01.000Z' }, context)).toBe(true);
    });
  });

  describe('date_range', () => {
    it('field within range returns true', () => {
      const node: ConditionNode = {
        field: 'created_at',
        op: 'date_range',
        value: { start: '2026-03-01T00:00:00.000Z', end: '2026-03-31T23:59:59.000Z' },
      };
      expect(evaluate(node, { created_at: '2026-03-15T12:00:00.000Z' }, context)).toBe(true);
    });

    it('field on start boundary returns true', () => {
      const node: ConditionNode = {
        field: 'created_at',
        op: 'date_range',
        value: { start: '2026-03-01T00:00:00.000Z', end: '2026-03-31T23:59:59.000Z' },
      };
      expect(evaluate(node, { created_at: '2026-03-01T00:00:00.000Z' }, context)).toBe(true);
    });

    it('field outside range returns false', () => {
      const node: ConditionNode = {
        field: 'created_at',
        op: 'date_range',
        value: { start: '2026-03-01T00:00:00.000Z', end: '2026-03-31T23:59:59.000Z' },
      };
      expect(evaluate(node, { created_at: '2026-04-01T00:00:00.000Z' }, context)).toBe(false);
    });
  });

  describe('missing field', () => {
    it('returns false for all temporal ops when field is undefined', () => {
      const ops = ['within_last', 'not_within_last', 'before', 'after', 'date_range'] as const;
      const values: Record<string, unknown> = {
        within_last: { amount: 5, unit: 'days' },
        not_within_last: { amount: 5, unit: 'days' },
        before: '2026-03-15T00:00:00.000Z',
        after: '2026-03-15T00:00:00.000Z',
        date_range: { start: '2026-03-01T00:00:00.000Z', end: '2026-03-31T23:59:59.000Z' },
      };
      for (const op of ops) {
        const node: ConditionNode = { field: 'missing', op, value: values[op] };
        expect(evaluate(node, {}, context)).toBe(false);
      }
    });
  });

  describe('context injection', () => {
    it('context.now is correctly used — different now changes result', () => {
      const fieldDate = '2026-03-10T12:00:00.000Z';
      const node: ConditionNode = {
        field: 'created_at',
        op: 'within_last',
        value: { amount: 3, unit: 'days' },
      };
      // With now = March 15, field (March 10) is 5 days ago → false
      expect(evaluate(node, { created_at: fieldDate }, { now: new Date('2026-03-15T12:00:00.000Z') })).toBe(false);
      // With now = March 12, field (March 10) is 2 days ago → true
      expect(evaluate(node, { created_at: fieldDate }, { now: new Date('2026-03-12T12:00:00.000Z') })).toBe(true);
    });
  });

  describe('error handling', () => {
    it('unknown temporal op throws', () => {
      const node = { field: 'created_at', op: 'unknown_temporal' } as unknown as FilterNode;
      expect(() => evaluate(node, { created_at: '2026-03-15T00:00:00.000Z' }, context)).toThrow();
    });

    it('calling temporal op without EvalContext throws', () => {
      const node: ConditionNode = {
        field: 'created_at',
        op: 'within_last',
        value: { amount: 5, unit: 'days' },
      };
      expect(() => evaluate(node, { created_at: '2026-03-15T00:00:00.000Z' })).toThrow(
        'EvalContext with { now: Date } is required for temporal operators',
      );
    });
  });
});
