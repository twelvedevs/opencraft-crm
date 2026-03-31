import { describe, it, expect } from 'vitest';
import { interpolateValue, interpolateFields } from '../src/interpolate.js';

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
});
