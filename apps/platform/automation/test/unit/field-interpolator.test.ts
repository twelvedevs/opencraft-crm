import { describe, it, expect } from 'vitest';
import {
  resolveValue,
  resolveParams,
  type ExecutionContext,
} from '../../src/services/field-interpolator.js';

const execCtx: ExecutionContext = {
  event_id: 'evt-123',
  execution_id: 'exec-456',
  rule_id: 'rule-789',
  rule_version: 2,
};

const eventCtx = {
  payload: {
    phone: '+15551234567',
    lead: {
      first_name: 'Alice',
      address: {
        city: 'Denver',
      },
    },
  },
  source: 'web',
};

describe('resolveValue', () => {
  it('resolves dot-notation path that is present', () => {
    expect(resolveValue('payload.phone', eventCtx, execCtx)).toBe('+15551234567');
  });

  it('returns undefined for dot-notation path that is missing', () => {
    expect(resolveValue('payload.missing', eventCtx, execCtx)).toBeUndefined();
  });

  it('resolves deeply nested dot-path', () => {
    expect(resolveValue('payload.lead.address.city', eventCtx, execCtx)).toBe('Denver');
  });

  it('resolves a single template token', () => {
    expect(resolveValue('{{event_id}}', eventCtx, execCtx)).toBe('evt-123');
  });

  it('resolves multiple template tokens in one string', () => {
    expect(resolveValue('{{event_id}}-{{rule_id}}', eventCtx, execCtx)).toBe('evt-123-rule-789');
  });

  it('leaves unknown template tokens as-is', () => {
    expect(resolveValue('{{unknown_key}}-suffix', eventCtx, execCtx)).toBe('{{unknown_key}}-suffix');
  });

  it('returns plain string literals unchanged', () => {
    expect(resolveValue('hello world', eventCtx, execCtx)).toBe('hello world');
  });

  it('returns numbers as-is', () => {
    expect(resolveValue(42, eventCtx, execCtx)).toBe(42);
  });

  it('returns booleans as-is', () => {
    expect(resolveValue(false, eventCtx, execCtx)).toBe(false);
  });

  it('returns null as-is', () => {
    expect(resolveValue(null, eventCtx, execCtx)).toBeNull();
  });

  it('returns objects as-is', () => {
    const obj = { a: 1 };
    expect(resolveValue(obj, eventCtx, execCtx)).toBe(obj);
  });

  it('returns arrays as-is', () => {
    const arr = [1, 2, 3];
    expect(resolveValue(arr, eventCtx, execCtx)).toBe(arr);
  });
});

describe('resolveParams', () => {
  it('recursively resolves string values in a nested object', () => {
    const params = {
      phone: 'payload.phone',
      meta: {
        exec: '{{execution_id}}',
      },
    };
    expect(resolveParams(params, eventCtx, execCtx)).toEqual({
      phone: '+15551234567',
      meta: {
        exec: 'exec-456',
      },
    });
  });

  it('recursively resolves string values in arrays', () => {
    const params = {
      items: ['source', '{{rule_id}}', 'hello world'],
    };
    expect(resolveParams(params, eventCtx, execCtx)).toEqual({
      items: ['web', 'rule-789', 'hello world'],
    });
  });

  it('resolves dot-path inside nested params object', () => {
    const params = {
      level1: {
        level2: {
          name: 'payload.lead.first_name',
        },
      },
    };
    expect(resolveParams(params, eventCtx, execCtx)).toEqual({
      level1: {
        level2: {
          name: 'Alice',
        },
      },
    });
  });
});
