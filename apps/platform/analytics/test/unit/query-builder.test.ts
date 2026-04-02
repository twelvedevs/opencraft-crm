import { describe, it, expect } from 'vitest';
import { buildQuery } from '../../src/services/query-builder.js';

describe('buildQuery', () => {
  it('count aggregate generates COUNT(*) with period WHERE clauses', () => {
    const { sql, bindings } = buildQuery({
      aggregate: 'count',
      granularity: 'total',
      period: { from: '2026-01-01', to: '2026-01-31' },
    });
    expect(sql).toContain('COUNT(*)');
    expect(sql).toContain('occurred_at >= $1::date');
    expect(sql).toContain("occurred_at < ($2::date + INTERVAL '1 day')");
    expect(bindings).toEqual(['2026-01-01', '2026-01-31']);
  });

  it('sum aggregate generates SUM(field::numeric)', () => {
    const { sql } = buildQuery({
      aggregate: 'sum',
      aggregate_field: 'dimensions.amount',
      granularity: 'total',
      period: { from: '2026-01-01', to: '2026-01-31' },
    });
    expect(sql).toContain("SUM(((dimensions->>'amount'))::numeric)");
  });

  it('avg aggregate generates AVG(field::numeric)', () => {
    const { sql } = buildQuery({
      aggregate: 'avg',
      aggregate_field: 'dimensions.score',
      granularity: 'total',
      period: { from: '2026-01-01', to: '2026-01-31' },
    });
    expect(sql).toContain("AVG(((dimensions->>'score'))::numeric)");
  });

  it('single-value filter generates equality clause', () => {
    const { sql, bindings } = buildQuery({
      aggregate: 'count',
      filters: [{ field: 'event_type', value: 'lead.created' }],
      granularity: 'total',
      period: { from: '2026-01-01', to: '2026-01-31' },
    });
    expect(sql).toContain('event_type = $3');
    expect(bindings[2]).toBe('lead.created');
  });

  it('multi-value filter generates ANY($n) clause', () => {
    const { sql, bindings } = buildQuery({
      aggregate: 'count',
      filters: [{ field: 'dimensions.channel', value: ['google', 'meta'] }],
      granularity: 'total',
      period: { from: '2026-01-01', to: '2026-01-31' },
    });
    expect(sql).toContain("(dimensions->>'channel') = ANY($3)");
    expect(bindings[2]).toEqual(['google', 'meta']);
  });

  it('group_by one field: adds alias to SELECT and column to GROUP BY', () => {
    const { sql } = buildQuery({
      aggregate: 'count',
      group_by: ['dimensions.channel'],
      granularity: 'total',
      period: { from: '2026-01-01', to: '2026-01-31' },
    });
    expect(sql).toContain("(dimensions->>'channel') AS dimensions_channel");
    expect(sql).toContain("GROUP BY (dimensions->>'channel')");
  });

  it('group_by two fields: both appear in SELECT and GROUP BY', () => {
    const { sql } = buildQuery({
      aggregate: 'count',
      group_by: ['dimensions.channel', 'dimensions.location_id'],
      granularity: 'total',
      period: { from: '2026-01-01', to: '2026-01-31' },
    });
    expect(sql).toContain("(dimensions->>'channel') AS dimensions_channel");
    expect(sql).toContain("(dimensions->>'location_id') AS dimensions_location_id");
    expect(sql).toContain("GROUP BY (dimensions->>'channel'), (dimensions->>'location_id')");
  });

  it('daily granularity: adds DATE_TRUNC(day) to SELECT and GROUP BY', () => {
    const { sql } = buildQuery({
      aggregate: 'count',
      granularity: 'daily',
      period: { from: '2026-01-01', to: '2026-01-31' },
    });
    expect(sql).toContain("DATE_TRUNC('day', occurred_at)");
    expect(sql).toContain('occurred_date');
    expect(sql).toContain('GROUP BY');
  });

  it('monthly granularity: adds DATE_TRUNC(month) to SELECT and GROUP BY', () => {
    const { sql } = buildQuery({
      aggregate: 'count',
      granularity: 'monthly',
      period: { from: '2026-01-01', to: '2026-12-31' },
    });
    expect(sql).toContain("DATE_TRUNC('month', occurred_at)");
    expect(sql).toContain('GROUP BY');
  });

  it('total granularity: no occurred_date or standalone GROUP BY in output', () => {
    const { sql } = buildQuery({
      aggregate: 'count',
      granularity: 'total',
      period: { from: '2026-01-01', to: '2026-01-31' },
    });
    expect(sql).not.toContain('GROUP BY');
    expect(sql).not.toContain('occurred_date');
  });

  it('period bindings are always the first two positional params', () => {
    const { bindings } = buildQuery({
      aggregate: 'count',
      granularity: 'total',
      period: { from: '2026-03-01', to: '2026-03-31' },
    });
    expect(bindings[0]).toBe('2026-03-01');
    expect(bindings[1]).toBe('2026-03-31');
  });

  it('throws on invalid field name in filters (SQL injection guard)', () => {
    expect(() =>
      buildQuery({
        aggregate: 'count',
        filters: [{ field: 'field; DROP TABLE analytics_events', value: 'x' }],
        granularity: 'total',
        period: { from: '2026-01-01', to: '2026-01-31' },
      }),
    ).toThrow('Invalid field name');
  });

  it('throws on invalid field name in group_by', () => {
    expect(() =>
      buildQuery({
        aggregate: 'count',
        group_by: ['dimensions.ok', 'bad field!'],
        granularity: 'total',
        period: { from: '2026-01-01', to: '2026-01-31' },
      }),
    ).toThrow('Invalid field name');
  });

  it('filter bindings follow period bindings (period=$1,$2, filter=$3)', () => {
    const { bindings } = buildQuery({
      aggregate: 'count',
      filters: [
        { field: 'dimensions.channel', value: 'google' },
        { field: 'dimensions.location_id', value: 'loc-1' },
      ],
      granularity: 'total',
      period: { from: '2026-01-01', to: '2026-01-31' },
    });
    expect(bindings[0]).toBe('2026-01-01');
    expect(bindings[1]).toBe('2026-01-31');
    expect(bindings[2]).toBe('google');
    expect(bindings[3]).toBe('loc-1');
  });
});
