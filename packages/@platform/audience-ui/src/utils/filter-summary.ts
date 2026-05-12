export function summarizeFilter(filter: unknown): string[] {
  if (!filter || typeof filter !== 'object') return [];

  const node = filter as Record<string, unknown>;

  // Leaf condition: { field, op, value? }
  if (typeof node['field'] === 'string' && typeof node['op'] === 'string') {
    return [formatCondition(node['field'], node['op'], node['value'])];
  }

  // Group: { op: 'AND'|'OR', conditions: FilterNode[] }
  if ((node['op'] === 'AND' || node['op'] === 'OR') && Array.isArray(node['conditions'])) {
    return (node['conditions'] as unknown[]).flatMap((child) => summarizeFilter(child));
  }

  // NOT: { op: 'NOT', condition: FilterNode }
  if (node['op'] === 'NOT' && node['condition']) {
    return summarizeFilter(node['condition']);
  }

  return [];
}

function formatCondition(field: string, op: string, value: unknown): string {
  const readableOp = OPERATOR_LABELS[op] ?? op;

  if (op === 'exists' || op === 'not_exists') {
    return `${field} ${readableOp}`;
  }

  if ((op === 'in' || op === 'not_in') && Array.isArray(value)) {
    return `${field} ${readableOp} [${(value as unknown[]).map(String).join(', ')}]`;
  }

  if ((op === 'within_last' || op === 'not_within_last') && value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    return `${field} ${readableOp} ${String(v['amount'] ?? '')} ${String(v['unit'] ?? 'days')}`;
  }

  if (op === 'date_range' && value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    return `${field} ${readableOp} ${String(v['start'] ?? '')} to ${String(v['end'] ?? '')}`;
  }

  return `${field} ${readableOp} ${String(value ?? '')}`;
}

const OPERATOR_LABELS: Record<string, string> = {
  eq: 'equals',
  neq: 'not equals',
  gt: 'greater than',
  gte: 'greater than or equal to',
  lt: 'less than',
  lte: 'less than or equal to',
  contains: 'contains',
  in: 'in',
  not_in: 'not in',
  exists: 'exists',
  not_exists: 'not exists',
  within_last: 'within last',
  not_within_last: 'not within last',
  before: 'before',
  after: 'after',
  date_range: 'in date range',
};
