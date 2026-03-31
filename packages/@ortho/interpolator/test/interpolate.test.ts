import { describe, it, expect } from 'vitest';
import { getByPath, interpolateValue, interpolateFields, resolveValue, resolveParams } from '../src/interpolate.js';

// ---------------------------------------------------------------------------
// getByPath
// ---------------------------------------------------------------------------

describe('getByPath', () => {
  it('resolves top-level key', () => {
    expect(getByPath({ phone: '+1555' }, 'phone')).toBe('+1555');
  });

  it('resolves nested path', () => {
    expect(getByPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('returns undefined for missing path', () => {
    expect(getByPath({ a: { b: 1 } }, 'a.x')).toBeUndefined();
  });

  it('returns undefined when traversing through null', () => {
    expect(getByPath({ a: null } as Record<string, unknown>, 'a.b')).toBeUndefined();
  });

  it('returns undefined when traversing through a primitive', () => {
    expect(getByPath({ a: 'hello' }, 'a.b')).toBeUndefined();
  });

  it('returns the object itself for a key pointing to an object', () => {
    const inner = { x: 1 };
    expect(getByPath({ a: inner }, 'a')).toBe(inner);
  });
});

// ---------------------------------------------------------------------------
// interpolateValue  (single-context, requires dot in path)
// ---------------------------------------------------------------------------

describe('interpolateValue', () => {
  it('dot-notation: resolves context.phone', () => {
    expect(interpolateValue('context.phone', { context: { phone: '+1555' } })).toBe('+1555');
  });

  it('dot-notation: resolves nested a.b.c', () => {
    expect(interpolateValue('a.b.c', { a: { b: { c: 42 } } })).toBe(42);
  });

  it('dot-notation: missing path returns undefined', () => {
    expect(interpolateValue('a.b.x', { a: { b: { c: 1 } } })).toBeUndefined();
  });

  it('single-segment string is treated as literal (not a path)', () => {
    expect(interpolateValue('haiku', { haiku: 'resolved' })).toBe('haiku');
  });

  it('template string: single token', () => {
    expect(interpolateValue('{{enrollment_id}}-step-1', { enrollment_id: 'abc123' })).toBe(
      'abc123-step-1',
    );
  });

  it('template string: multiple tokens', () => {
    expect(
      interpolateValue('{{entity_type}}/{{entity_id}}', { entity_type: 'lead', entity_id: '456' }),
    ).toBe('lead/456');
  });

  it('template string: missing key preserved as literal', () => {
    expect(interpolateValue('{{missing}}-suffix', {})).toBe('{{missing}}-suffix');
  });

  it('plain string: returned unchanged', () => {
    expect(interpolateValue('literal_value', {})).toBe('literal_value');
  });

  it('number: returned unchanged', () => {
    expect(interpolateValue(99, {})).toBe(99);
  });

  it('boolean false: returned unchanged', () => {
    expect(interpolateValue(false, {})).toBe(false);
  });

  it('null: returned unchanged', () => {
    expect(interpolateValue(null, {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// interpolateFields  (single-context, recursive)
// ---------------------------------------------------------------------------

describe('interpolateFields', () => {
  it('flat object with dot-notation and template token', () => {
    const result = interpolateFields(
      { to: 'context.phone', dedup_key: '{{enrollment_id}}-step-1' },
      { context: { phone: '+1999' }, enrollment_id: 'e1' },
    );
    expect(result).toEqual({ to: '+1999', dedup_key: 'e1-step-1' });
  });

  it('nested object with array', () => {
    const result = interpolateFields(
      { payload: { ids: ['context.id', 'literal'] } },
      { context: { id: 'x1' } },
    );
    expect(result).toEqual({ payload: { ids: ['x1', 'literal'] } });
  });

  it('non-string values passed through unchanged', () => {
    const result = interpolateFields(
      { count: 5, flag: true, nothing: null },
      {},
    );
    expect(result).toEqual({ count: 5, flag: true, nothing: null });
  });

  it('deeply nested objects are recursively resolved', () => {
    const result = interpolateFields(
      { level1: { level2: { val: 'context.name' } } },
      { context: { name: 'Alice' } },
    );
    expect(result).toEqual({ level1: { level2: { val: 'Alice' } } });
  });
});

// ---------------------------------------------------------------------------
// resolveValue  (dual-context: dataCtx for dot-paths, templateCtx for tokens)
// ---------------------------------------------------------------------------

describe('resolveValue (dual-context)', () => {
  const dataCtx = {
    payload: {
      phone: '+15551234567',
      lead: { first_name: 'Alice', address: { city: 'Denver' } },
    },
    source: 'web',
  };

  const templateCtx = {
    event_id: 'evt-123',
    execution_id: 'exec-456',
    rule_id: 'rule-789',
    rule_version: 2,
  };

  it('resolves dotted path from dataCtx', () => {
    expect(resolveValue('payload.phone', dataCtx, templateCtx)).toBe('+15551234567');
  });

  it('resolves deeply nested dotted path', () => {
    expect(resolveValue('payload.lead.address.city', dataCtx, templateCtx)).toBe('Denver');
  });

  it('treats single-segment string as literal (dot required for path)', () => {
    expect(resolveValue('source', dataCtx, templateCtx)).toBe('source');
  });

  it('returns undefined for missing path', () => {
    expect(resolveValue('payload.missing', dataCtx, templateCtx)).toBeUndefined();
  });

  it('resolves single template token from templateCtx', () => {
    expect(resolveValue('{{event_id}}', dataCtx, templateCtx)).toBe('evt-123');
  });

  it('resolves multiple template tokens', () => {
    expect(resolveValue('{{event_id}}-{{rule_id}}', dataCtx, templateCtx)).toBe('evt-123-rule-789');
  });

  it('leaves unknown template tokens as-is', () => {
    expect(resolveValue('{{unknown}}-suffix', dataCtx, templateCtx)).toBe('{{unknown}}-suffix');
  });

  it('returns plain string literals (with spaces/special chars) unchanged', () => {
    expect(resolveValue('hello world', dataCtx, templateCtx)).toBe('hello world');
  });

  it('returns numbers as-is', () => {
    expect(resolveValue(42, dataCtx, templateCtx)).toBe(42);
  });

  it('returns booleans as-is', () => {
    expect(resolveValue(false, dataCtx, templateCtx)).toBe(false);
  });

  it('returns null as-is', () => {
    expect(resolveValue(null, dataCtx, templateCtx)).toBeNull();
  });

  it('returns objects as-is (not a string)', () => {
    const obj = { a: 1 };
    expect(resolveValue(obj, dataCtx, templateCtx)).toBe(obj);
  });

  it('returns arrays as-is (not a string)', () => {
    const arr = [1, 2, 3];
    expect(resolveValue(arr, dataCtx, templateCtx)).toBe(arr);
  });

  it('template tokens resolve from templateCtx, not dataCtx', () => {
    // "source" exists in dataCtx, but {{source}} should resolve from templateCtx
    expect(resolveValue('{{source}}', dataCtx, templateCtx)).toBe('{{source}}');
  });
});

// ---------------------------------------------------------------------------
// resolveParams  (dual-context, recursive)
// ---------------------------------------------------------------------------

describe('resolveParams (dual-context)', () => {
  const dataCtx = {
    payload: {
      phone: '+15551234567',
      lead: { first_name: 'Alice' },
    },
    source: 'web',
  };

  const templateCtx = {
    event_id: 'evt-123',
    execution_id: 'exec-456',
    rule_id: 'rule-789',
    rule_version: 2,
  };

  it('recursively resolves nested objects', () => {
    const params = {
      phone: 'payload.phone',
      meta: { exec: '{{execution_id}}' },
    };
    expect(resolveParams(params, dataCtx, templateCtx)).toEqual({
      phone: '+15551234567',
      meta: { exec: 'exec-456' },
    });
  });

  it('recursively resolves arrays', () => {
    const params = {
      items: ['payload.phone', '{{rule_id}}', 'hello world'],
    };
    expect(resolveParams(params, dataCtx, templateCtx)).toEqual({
      items: ['+15551234567', 'rule-789', 'hello world'],
    });
  });

  it('resolves dot-path inside deeply nested params', () => {
    const params = {
      level1: { level2: { name: 'payload.lead.first_name' } },
    };
    expect(resolveParams(params, dataCtx, templateCtx)).toEqual({
      level1: { level2: { name: 'Alice' } },
    });
  });

  it('passes non-string values through unchanged', () => {
    const params = { count: 5, flag: true, nothing: null };
    expect(resolveParams(params, dataCtx, templateCtx)).toEqual({
      count: 5, flag: true, nothing: null,
    });
  });

  it('handles mixed nested objects, arrays, and scalars', () => {
    const params = {
      event_type: 'automation-action-requested',
      payload: {
        action: 'assign_coordinator',
        entity_id: 'payload.lead.first_name',
        tags: ['payload.phone', '{{event_id}}'],
        priority: 1,
      },
    };
    expect(resolveParams(params, dataCtx, templateCtx)).toEqual({
      event_type: 'automation-action-requested',
      payload: {
        action: 'assign_coordinator',
        entity_id: 'Alice',
        tags: ['+15551234567', 'evt-123'],
        priority: 1,
      },
    });
  });

  it('single-segment strings in params are treated as literals', () => {
    const params = { model: 'haiku', context: 'payload' };
    expect(resolveParams(params, dataCtx, templateCtx)).toEqual({
      model: 'haiku',
      context: 'payload',
    });
  });
});
