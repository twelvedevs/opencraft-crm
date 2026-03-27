import { describe, it, expect } from 'vitest';
import { evaluate } from '../../src/services/condition-evaluator.js';
import type { Condition } from '../../src/services/condition-evaluator.js';
import type { ExecutionContext } from '../../src/services/field-interpolator.js';

const execCtx: ExecutionContext = {
  event_id: 'evt-1',
  execution_id: 'exec-1',
  rule_id: 'rule-1',
  rule_version: 1,
};

const event = {
  payload: {
    age: 30,
    name: 'Alice',
    tags: ['vip', 'active'],
    score: 85.5,
    status: 'active',
    note: 'hello world',
  },
  source: 'web',
};

describe('evaluate — null/undefined condition', () => {
  it('returns true for null', () => {
    expect(evaluate(null, event, execCtx)).toBe(true);
  });

  it('returns true for undefined', () => {
    expect(evaluate(undefined, event, execCtx)).toBe(true);
  });
});

describe('evaluate — eq', () => {
  it('returns true when field equals value', () => {
    const c: Condition = { field: 'payload.status', op: 'eq', value: 'active' };
    expect(evaluate(c, event, execCtx)).toBe(true);
  });

  it('returns false when field does not equal value', () => {
    const c: Condition = { field: 'payload.status', op: 'eq', value: 'inactive' };
    expect(evaluate(c, event, execCtx)).toBe(false);
  });
});

describe('evaluate — neq', () => {
  it('returns true when field differs from value', () => {
    const c: Condition = { field: 'payload.status', op: 'neq', value: 'inactive' };
    expect(evaluate(c, event, execCtx)).toBe(true);
  });

  it('returns false when field matches value', () => {
    const c: Condition = { field: 'payload.status', op: 'neq', value: 'active' };
    expect(evaluate(c, event, execCtx)).toBe(false);
  });
});

describe('evaluate — in', () => {
  it('returns true when field value is in array', () => {
    const c: Condition = { field: 'payload.status', op: 'in', value: ['active', 'pending'] };
    expect(evaluate(c, event, execCtx)).toBe(true);
  });

  it('returns false when field value is not in array', () => {
    const c: Condition = { field: 'payload.status', op: 'in', value: ['inactive', 'deleted'] };
    expect(evaluate(c, event, execCtx)).toBe(false);
  });
});

describe('evaluate — not_in', () => {
  it('returns true when field value is not in array', () => {
    const c: Condition = { field: 'payload.status', op: 'not_in', value: ['inactive', 'deleted'] };
    expect(evaluate(c, event, execCtx)).toBe(true);
  });

  it('returns false when field value is in array', () => {
    const c: Condition = { field: 'payload.status', op: 'not_in', value: ['active', 'pending'] };
    expect(evaluate(c, event, execCtx)).toBe(false);
  });
});

describe('evaluate — gt/gte/lt/lte', () => {
  it('gt: returns true when field > value', () => {
    const c: Condition = { field: 'payload.age', op: 'gt', value: 25 };
    expect(evaluate(c, event, execCtx)).toBe(true);
  });

  it('gt: returns false when field <= value', () => {
    const c: Condition = { field: 'payload.age', op: 'gt', value: 30 };
    expect(evaluate(c, event, execCtx)).toBe(false);
  });

  it('gte: returns true when field >= value', () => {
    const c: Condition = { field: 'payload.age', op: 'gte', value: 30 };
    expect(evaluate(c, event, execCtx)).toBe(true);
  });

  it('gte: returns false when field < value', () => {
    const c: Condition = { field: 'payload.age', op: 'gte', value: 31 };
    expect(evaluate(c, event, execCtx)).toBe(false);
  });

  it('lt: returns true when field < value', () => {
    const c: Condition = { field: 'payload.age', op: 'lt', value: 31 };
    expect(evaluate(c, event, execCtx)).toBe(true);
  });

  it('lt: returns false when field >= value', () => {
    const c: Condition = { field: 'payload.age', op: 'lt', value: 30 };
    expect(evaluate(c, event, execCtx)).toBe(false);
  });

  it('lte: returns true when field <= value', () => {
    const c: Condition = { field: 'payload.age', op: 'lte', value: 30 };
    expect(evaluate(c, event, execCtx)).toBe(true);
  });

  it('lte: returns false when field > value', () => {
    const c: Condition = { field: 'payload.age', op: 'lte', value: 29 };
    expect(evaluate(c, event, execCtx)).toBe(false);
  });
});

describe('evaluate — contains', () => {
  it('returns true when string field contains substring', () => {
    const c: Condition = { field: 'payload.note', op: 'contains', value: 'hello' };
    expect(evaluate(c, event, execCtx)).toBe(true);
  });

  it('returns false when string field does not contain substring', () => {
    const c: Condition = { field: 'payload.note', op: 'contains', value: 'goodbye' };
    expect(evaluate(c, event, execCtx)).toBe(false);
  });

  it('returns true when array field contains item', () => {
    const c: Condition = { field: 'payload.tags', op: 'contains', value: 'vip' };
    expect(evaluate(c, event, execCtx)).toBe(true);
  });

  it('returns false when array field does not contain item', () => {
    const c: Condition = { field: 'payload.tags', op: 'contains', value: 'premium' };
    expect(evaluate(c, event, execCtx)).toBe(false);
  });
});

describe('evaluate — exists/not_exists', () => {
  it('exists: returns true when field is present', () => {
    const c: Condition = { field: 'payload.name', op: 'exists' };
    expect(evaluate(c, event, execCtx)).toBe(true);
  });

  it('exists: returns false when field is missing', () => {
    const c: Condition = { field: 'payload.missing', op: 'exists' };
    expect(evaluate(c, event, execCtx)).toBe(false);
  });

  it('not_exists: returns true when field is missing', () => {
    const c: Condition = { field: 'payload.missing', op: 'not_exists' };
    expect(evaluate(c, event, execCtx)).toBe(true);
  });

  it('not_exists: returns false when field is present', () => {
    const c: Condition = { field: 'payload.name', op: 'not_exists' };
    expect(evaluate(c, event, execCtx)).toBe(false);
  });
});

describe('evaluate — AND', () => {
  it('returns true when all sub-conditions are true', () => {
    const c: Condition = {
      op: 'AND',
      conditions: [
        { field: 'payload.status', op: 'eq', value: 'active' },
        { field: 'payload.age', op: 'gt', value: 20 },
      ],
    };
    expect(evaluate(c, event, execCtx)).toBe(true);
  });

  it('returns false when one sub-condition is false', () => {
    const c: Condition = {
      op: 'AND',
      conditions: [
        { field: 'payload.status', op: 'eq', value: 'active' },
        { field: 'payload.age', op: 'gt', value: 100 },
      ],
    };
    expect(evaluate(c, event, execCtx)).toBe(false);
  });
});

describe('evaluate — OR', () => {
  it('returns true when at least one sub-condition is true', () => {
    const c: Condition = {
      op: 'OR',
      conditions: [
        { field: 'payload.status', op: 'eq', value: 'inactive' },
        { field: 'payload.age', op: 'gt', value: 20 },
      ],
    };
    expect(evaluate(c, event, execCtx)).toBe(true);
  });

  it('returns false when all sub-conditions are false', () => {
    const c: Condition = {
      op: 'OR',
      conditions: [
        { field: 'payload.status', op: 'eq', value: 'inactive' },
        { field: 'payload.age', op: 'gt', value: 100 },
      ],
    };
    expect(evaluate(c, event, execCtx)).toBe(false);
  });
});

describe('evaluate — NOT', () => {
  it('negates a true condition to false', () => {
    const c: Condition = {
      op: 'NOT',
      condition: { field: 'payload.status', op: 'eq', value: 'active' },
    };
    expect(evaluate(c, event, execCtx)).toBe(false);
  });

  it('negates a false condition to true', () => {
    const c: Condition = {
      op: 'NOT',
      condition: { field: 'payload.status', op: 'eq', value: 'inactive' },
    };
    expect(evaluate(c, event, execCtx)).toBe(true);
  });
});

describe('evaluate — nested AND/OR/NOT three levels deep', () => {
  it('evaluates correctly', () => {
    // AND( OR( NOT(age > 100), status == active ), score >= 85 )
    const c: Condition = {
      op: 'AND',
      conditions: [
        {
          op: 'OR',
          conditions: [
            {
              op: 'NOT',
              condition: { field: 'payload.age', op: 'gt', value: 100 },
            },
            { field: 'payload.status', op: 'eq', value: 'inactive' },
          ],
        },
        { field: 'payload.score', op: 'gte', value: 85 },
      ],
    };
    expect(evaluate(c, event, execCtx)).toBe(true);
  });
});

describe('evaluate — missing field', () => {
  it('returns false for comparison operators when field is missing', () => {
    const ops: Array<LeafCondition['op']> = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'contains'];
    for (const op of ops) {
      const c: Condition = { field: 'payload.nonexistent', op, value: 'anything' };
      expect(evaluate(c, event, execCtx), `op=${op} should return false for missing field`).toBe(false);
    }
  });
});

describe('evaluate — field resolved via dot-path', () => {
  it('resolves nested dot-path fields correctly', () => {
    const c: Condition = { field: 'payload.name', op: 'eq', value: 'Alice' };
    expect(evaluate(c, event, execCtx)).toBe(true);
  });
});

// Need to import LeafCondition type for the test above
type LeafCondition = import('../../src/services/condition-evaluator.js').LeafCondition;
