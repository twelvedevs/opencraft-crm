import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FilterEvaluator } from '../../src/services/filter-evaluator.js';

// Mock @platform/filter-engine
vi.mock('@platform/filter-engine', () => ({
  evaluate: vi.fn(),
}));

import { evaluate } from '@platform/filter-engine';
const mockEvaluate = evaluate as ReturnType<typeof vi.fn>;

describe('FilterEvaluator', () => {
  let evaluator: FilterEvaluator;

  beforeEach(() => {
    vi.restoreAllMocks();
    evaluator = new FilterEvaluator();
  });

  it('simple eq filter matches entity field', () => {
    mockEvaluate.mockReturnValue(true);

    const filter = { field: 'status', op: 'eq', value: 'active' };
    const entity = { status: 'active' };

    const result = evaluator.evaluate(filter, entity);

    expect(result).toBe(true);
    expect(mockEvaluate).toHaveBeenCalledWith(
      filter,
      entity,
      expect.objectContaining({ now: expect.any(Date) }),
    );
  });

  it('not_within_last filter: entity 6 days ago returns true, 4 days ago returns false', () => {
    const filter = { field: 'created_at', op: 'not_within_last', value: { amount: 5, unit: 'days' } };

    // 6 days ago: should match not_within_last 5 days
    mockEvaluate.mockReturnValue(true);
    const entity6 = { created_at: new Date(Date.now() - 6 * 86400000).toISOString() };
    expect(evaluator.evaluate(filter, entity6)).toBe(true);

    // 4 days ago: should not match not_within_last 5 days
    mockEvaluate.mockReturnValue(false);
    const entity4 = { created_at: new Date(Date.now() - 4 * 86400000).toISOString() };
    expect(evaluator.evaluate(filter, entity4)).toBe(false);
  });

  it('EvalContext is injected with a Date object for now', () => {
    mockEvaluate.mockReturnValue(true);
    const beforeCall = Date.now();
    evaluator.evaluate({ field: 'x', op: 'eq', value: 1 }, { x: 1 });
    const afterCall = Date.now();

    const callArgs = mockEvaluate.mock.calls[0];
    const context = callArgs[2] as { now: Date };
    expect(context.now).toBeInstanceOf(Date);
    expect(context.now.getTime()).toBeGreaterThanOrEqual(beforeCall);
    expect(context.now.getTime()).toBeLessThanOrEqual(afterCall);
  });

  it('passes through filter-engine errors without swallowing', () => {
    mockEvaluate.mockImplementation(() => {
      throw new Error('Unknown base operator: bad_op');
    });

    expect(() =>
      evaluator.evaluate({ field: 'x', op: 'bad_op' as any, value: 1 }, { x: 1 }),
    ).toThrow('Unknown base operator: bad_op');
  });
});
