import { describe, it, expect } from 'vitest';
import { evaluate } from '../src/evaluate.js';
import type { FilterNode } from '../src/types.js';

describe('filter-engine base operators', () => {
  it('eq match', () => {
    const filter: FilterNode = { field: 'status', op: 'eq', value: 'active' };
    expect(evaluate(filter, { status: 'active' })).toBe(true);
  });

  it('eq miss', () => {
    const filter: FilterNode = { field: 'status', op: 'eq', value: 'active' };
    expect(evaluate(filter, { status: 'draft' })).toBe(false);
  });

  it('neq', () => {
    const filter: FilterNode = { field: 'status', op: 'neq', value: 'active' };
    expect(evaluate(filter, { status: 'draft' })).toBe(true);
  });

  it('in match', () => {
    const filter: FilterNode = { field: 'role', op: 'in', value: ['admin', 'editor'] };
    expect(evaluate(filter, { role: 'admin' })).toBe(true);
  });

  it('in miss', () => {
    const filter: FilterNode = { field: 'role', op: 'in', value: ['admin', 'editor'] };
    expect(evaluate(filter, { role: 'viewer' })).toBe(false);
  });

  it('not_in', () => {
    const filter: FilterNode = { field: 'role', op: 'not_in', value: ['admin'] };
    expect(evaluate(filter, { role: 'viewer' })).toBe(true);
  });

  it('gt', () => {
    const filter: FilterNode = { field: 'age', op: 'gt', value: 18 };
    expect(evaluate(filter, { age: 25 })).toBe(true);
    expect(evaluate(filter, { age: 18 })).toBe(false);
  });

  it('gte', () => {
    const filter: FilterNode = { field: 'age', op: 'gte', value: 18 };
    expect(evaluate(filter, { age: 18 })).toBe(true);
    expect(evaluate(filter, { age: 17 })).toBe(false);
  });

  it('lt', () => {
    const filter: FilterNode = { field: 'score', op: 'lt', value: 100 };
    expect(evaluate(filter, { score: 50 })).toBe(true);
    expect(evaluate(filter, { score: 100 })).toBe(false);
  });

  it('lte', () => {
    const filter: FilterNode = { field: 'score', op: 'lte', value: 100 };
    expect(evaluate(filter, { score: 100 })).toBe(true);
    expect(evaluate(filter, { score: 101 })).toBe(false);
  });

  it('contains on string', () => {
    const filter: FilterNode = { field: 'name', op: 'contains', value: 'ohn' };
    expect(evaluate(filter, { name: 'John' })).toBe(true);
    expect(evaluate(filter, { name: 'Jane' })).toBe(false);
  });

  it('contains on array', () => {
    const filter: FilterNode = { field: 'tags', op: 'contains', value: 'vip' };
    expect(evaluate(filter, { tags: ['vip', 'new'] })).toBe(true);
    expect(evaluate(filter, { tags: ['new'] })).toBe(false);
  });

  it('exists on present field', () => {
    const filter: FilterNode = { field: 'email', op: 'exists' };
    expect(evaluate(filter, { email: 'test@test.com' })).toBe(true);
  });

  it('not_exists on missing field', () => {
    const filter: FilterNode = { field: 'phone', op: 'not_exists' };
    expect(evaluate(filter, { email: 'test@test.com' })).toBe(true);
  });

  it('exists on null returns false', () => {
    const filter: FilterNode = { field: 'email', op: 'exists' };
    expect(evaluate(filter, { email: null })).toBe(false);
  });
});

describe('filter-engine group and NOT nodes', () => {
  it('AND group all match', () => {
    const filter: FilterNode = {
      op: 'AND',
      conditions: [
        { field: 'status', op: 'eq', value: 'active' },
        { field: 'age', op: 'gt', value: 18 },
      ],
    };
    expect(evaluate(filter, { status: 'active', age: 25 })).toBe(true);
  });

  it('AND group one fails', () => {
    const filter: FilterNode = {
      op: 'AND',
      conditions: [
        { field: 'status', op: 'eq', value: 'active' },
        { field: 'age', op: 'gt', value: 18 },
      ],
    };
    expect(evaluate(filter, { status: 'active', age: 15 })).toBe(false);
  });

  it('OR group one matches', () => {
    const filter: FilterNode = {
      op: 'OR',
      conditions: [
        { field: 'status', op: 'eq', value: 'active' },
        { field: 'status', op: 'eq', value: 'pending' },
      ],
    };
    expect(evaluate(filter, { status: 'pending' })).toBe(true);
  });

  it('OR group all fail', () => {
    const filter: FilterNode = {
      op: 'OR',
      conditions: [
        { field: 'status', op: 'eq', value: 'active' },
        { field: 'status', op: 'eq', value: 'pending' },
      ],
    };
    expect(evaluate(filter, { status: 'draft' })).toBe(false);
  });

  it('NOT node inverts result', () => {
    const filter: FilterNode = {
      op: 'NOT',
      condition: { field: 'status', op: 'eq', value: 'active' },
    };
    expect(evaluate(filter, { status: 'draft' })).toBe(true);
    expect(evaluate(filter, { status: 'active' })).toBe(false);
  });

  it('nested AND inside OR', () => {
    const filter: FilterNode = {
      op: 'OR',
      conditions: [
        {
          op: 'AND',
          conditions: [
            { field: 'status', op: 'eq', value: 'active' },
            { field: 'role', op: 'eq', value: 'admin' },
          ],
        },
        { field: 'superuser', op: 'eq', value: true },
      ],
    };
    expect(evaluate(filter, { status: 'active', role: 'admin', superuser: false })).toBe(true);
    expect(evaluate(filter, { status: 'draft', role: 'viewer', superuser: true })).toBe(true);
    expect(evaluate(filter, { status: 'draft', role: 'viewer', superuser: false })).toBe(false);
  });
});

describe('filter-engine edge cases', () => {
  it('missing field with eq returns false', () => {
    const filter: FilterNode = { field: 'missing', op: 'eq', value: 'x' };
    expect(evaluate(filter, {})).toBe(false);
  });

  it('missing field with not_exists returns true', () => {
    const filter: FilterNode = { field: 'missing', op: 'not_exists' };
    expect(evaluate(filter, {})).toBe(true);
  });

  it('dot-notation nested path resolved correctly', () => {
    const filter: FilterNode = { field: 'address.city', op: 'eq', value: 'NYC' };
    expect(evaluate(filter, { address: { city: 'NYC' } })).toBe(true);
    expect(evaluate(filter, { address: { city: 'LA' } })).toBe(false);
  });

  it('dot-notation with null intermediate returns false', () => {
    const filter: FilterNode = { field: 'address.city', op: 'eq', value: 'NYC' };
    expect(evaluate(filter, { address: null })).toBe(false);
  });

  it('unknown op throws descriptive error', () => {
    const filter = { field: 'x', op: 'banana', value: 1 } as unknown as FilterNode;
    expect(() => evaluate(filter, { x: 1 })).toThrow('Unknown base operator: banana');
  });

  it('temporal op without context throws descriptive error', () => {
    const filter: FilterNode = { field: 'created_at', op: 'within_last', value: { amount: 5, unit: 'days' } };
    expect(() => evaluate(filter, { created_at: '2024-01-01' })).toThrow('Temporal operator requires EvalContext');
  });
});
