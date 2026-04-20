import { describe, it, expect } from 'vitest';
import { summarizeFilter } from '../src/utils/filter-summary.js';

describe('summarizeFilter', () => {
  it('returns empty array for null', () => {
    expect(summarizeFilter(null)).toEqual([]);
  });

  it('summarizes a single leaf condition', () => {
    const result = summarizeFilter({ field: 'stage', op: 'eq', value: 'contacted' });
    expect(result).toEqual(['stage equals contacted']);
  });

  it('summarizes AND group by flattening children', () => {
    const result = summarizeFilter({
      op: 'AND',
      conditions: [
        { field: 'pipeline', op: 'eq', value: 'new_patient' },
        { field: 'opted_out', op: 'eq', value: false },
      ],
    });
    expect(result).toEqual(['pipeline equals new_patient', 'opted_out equals false']);
  });

  it('summarizes OR group', () => {
    const result = summarizeFilter({
      op: 'OR',
      conditions: [
        { field: 'stage', op: 'eq', value: 'contacted' },
        { field: 'stage', op: 'eq', value: 'exam_scheduled' },
      ],
    });
    expect(result).toEqual(['stage equals contacted', 'stage equals exam_scheduled']);
  });

  it('summarizes NOT node by delegating to child', () => {
    const result = summarizeFilter({
      op: 'NOT',
      condition: { field: 'opted_out', op: 'eq', value: true },
    });
    expect(result).toEqual(['opted_out equals true']);
  });

  it('formats in / not_in with brackets', () => {
    const result = summarizeFilter({ field: 'stage', op: 'in', value: ['contacted', 'exam_scheduled'] });
    expect(result).toEqual(['stage in [contacted, exam_scheduled]']);
  });

  it('formats within_last with amount and unit', () => {
    const result = summarizeFilter({ field: 'last_contact_at', op: 'within_last', value: { amount: 5, unit: 'days' } });
    expect(result).toEqual(['last_contact_at within last 5 days']);
  });

  it('formats not_within_last with amount and unit', () => {
    const result = summarizeFilter({ field: 'last_contact_at', op: 'not_within_last', value: { amount: 3, unit: 'hours' } });
    expect(result).toEqual(['last_contact_at not within last 3 hours']);
  });

  it('formats exists / not_exists without value', () => {
    expect(summarizeFilter({ field: 'tags', op: 'exists' })).toEqual(['tags exists']);
    expect(summarizeFilter({ field: 'tags', op: 'not_exists' })).toEqual(['tags not exists']);
  });

  it('returns empty array for unknown shape', () => {
    expect(summarizeFilter({ foo: 'bar' })).toEqual([]);
  });
});
