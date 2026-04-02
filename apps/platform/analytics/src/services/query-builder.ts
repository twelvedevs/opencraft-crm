/**
 * Pure-function query builder for POST /analytics/query.
 *
 * Translates a QueryParams struct into a parameterised SQL string + bindings
 * array suitable for passing directly to pg's pool.query(sql, bindings).
 *
 * Dot-notation mapping:
 *   dimensions.channel  → (dimensions->>'channel')
 *   properties.foo      → (properties->>'foo')
 *   event_type          → event_type   (direct column, no dot)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FilterParam {
  /** Dot-notation field name (e.g. "dimensions.channel") or plain column name */
  field: string;
  /** Single value for equality; array for IN matching */
  value: string | string[];
}

export interface QueryParams {
  aggregate: 'count' | 'sum' | 'avg';
  /** Required for sum/avg. Dot-notation into dimensions/properties jsonb. */
  aggregate_field?: string;
  filters?: FilterParam[];
  group_by?: string[];
  granularity: 'daily' | 'monthly' | 'total';
  period: { from: string; to: string };
}

export interface QueryResult {
  sql: string;
  bindings: unknown[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate that a field name contains only safe characters. */
function isValidField(field: string): boolean {
  return /^[a-z_][a-z0-9_.]*$/i.test(field);
}

/**
 * Convert dot-notation field to a SQL expression.
 * "dimensions.channel"  → (dimensions->>'channel')
 * "event_type"          → event_type
 */
function fieldToSql(field: string): string {
  const dotIndex = field.indexOf('.');
  if (dotIndex !== -1) {
    const col = field.substring(0, dotIndex);
    const key = field.substring(dotIndex + 1);
    return `(${col}->>'${key}')`;
  }
  return field;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildQuery(params: QueryParams): QueryResult {
  const bindings: unknown[] = [];

  // ---- Validate all field names upfront to guard against injection ----
  const allFields: string[] = [
    ...(params.aggregate_field ? [params.aggregate_field] : []),
    ...(params.filters ?? []).map((f) => f.field),
    ...(params.group_by ?? []),
  ];
  for (const field of allFields) {
    if (!isValidField(field)) {
      throw new Error(`Invalid field name: "${field}"`);
    }
  }

  // ---- Aggregate expression ----
  let aggregateExpr: string;
  if (params.aggregate === 'count') {
    aggregateExpr = 'COUNT(*)';
  } else {
    const field = fieldToSql(params.aggregate_field!);
    const fn = params.aggregate === 'sum' ? 'SUM' : 'AVG';
    aggregateExpr = `${fn}((${field})::numeric)`;
  }

  // ---- WHERE: period bounds (inclusive on both ends, day granularity) ----
  bindings.push(params.period.from);
  bindings.push(params.period.to);
  const whereClauses: string[] = [
    `occurred_at >= $1::date`,
    `occurred_at < ($2::date + INTERVAL '1 day')`,
  ];

  // ---- WHERE: additional filters ----
  for (const f of params.filters ?? []) {
    const col = fieldToSql(f.field);
    if (Array.isArray(f.value)) {
      bindings.push(f.value);
      whereClauses.push(`${col} = ANY($${bindings.length})`);
    } else {
      bindings.push(f.value);
      whereClauses.push(`${col} = $${bindings.length}`);
    }
  }

  // ---- SELECT columns ----
  const selectParts: string[] = [];

  // Date column (omitted for 'total')
  let dateGroupExpr: string | null = null;
  if (params.granularity === 'daily') {
    dateGroupExpr = "DATE_TRUNC('day', occurred_at)";
    selectParts.push(`${dateGroupExpr}::date::text AS occurred_date`);
  } else if (params.granularity === 'monthly') {
    dateGroupExpr = "DATE_TRUNC('month', occurred_at)";
    selectParts.push(`${dateGroupExpr}::date::text AS occurred_date`);
  }

  // group_by dimension columns
  const groupByFields = params.group_by ?? [];
  for (const f of groupByFields) {
    const colExpr = fieldToSql(f);
    const alias = f.replace(/\./g, '_');
    selectParts.push(`${colExpr} AS ${alias}`);
  }

  selectParts.push(`${aggregateExpr} AS value`);

  // ---- GROUP BY ----
  const groupByParts: string[] = [];
  if (dateGroupExpr) groupByParts.push(dateGroupExpr);
  for (const f of groupByFields) groupByParts.push(fieldToSql(f));

  // ---- Assemble SQL ----
  const parts: string[] = [
    `SELECT ${selectParts.join(', ')}`,
    `FROM platform_analytics.analytics_events`,
    `WHERE ${whereClauses.join(' AND ')}`,
  ];
  if (groupByParts.length > 0) {
    parts.push(`GROUP BY ${groupByParts.join(', ')}`);
  }

  return { sql: parts.join(' '), bindings };
}
