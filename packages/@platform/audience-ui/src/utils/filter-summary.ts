/**
 * Walks a filter tree and returns human-readable strings for each leaf condition.
 * Group/NOT nodes are flattened into their children for summary purposes.
 */
export function summarizeFilter(filter: unknown): string[] {
  if (!filter || typeof filter !== 'object') return [];

  const node = filter as Record<string, unknown>;

  // Leaf condition node
  if (node.field && node.operator) {
    const field = String(node.field);
    const operator = String(node.operator);
    const value = node.value;
    return [formatCondition(field, operator, value)];
  }

  // Group node (AND/OR)
  if (node.type === 'group' && Array.isArray(node.children)) {
    return (node.children as unknown[]).flatMap((child) => summarizeFilter(child));
  }

  // NOT node
  if (node.type === 'not' && node.child) {
    return summarizeFilter(node.child);
  }

  return [];
}

function formatCondition(field: string, operator: string, value: unknown): string {
  const readableOp = OPERATOR_LABELS[operator] ?? operator;

  if (operator === 'is_empty' || operator === 'is_not_empty') {
    return `${field} ${readableOp}`;
  }

  if (operator === 'between' && Array.isArray(value) && value.length === 2) {
    return `${field} ${readableOp} ${String(value[0])} and ${String(value[1])}`;
  }

  if (operator === 'in' || operator === 'not_in') {
    const items = Array.isArray(value) ? value.map(String).join(', ') : String(value ?? '');
    return `${field} ${readableOp} [${items}]`;
  }

  if (operator === 'within_last' || operator === 'not_within_last') {
    const amount = (value as Record<string, unknown>)?.amount ?? value;
    const unit = (value as Record<string, unknown>)?.unit ?? 'days';
    return `${field} ${readableOp} ${String(amount)} ${String(unit)}`;
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
  not_contains: 'not contains',
  starts_with: 'starts with',
  ends_with: 'ends with',
  in: 'in',
  not_in: 'not in',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
  between: 'between',
  within_last: 'within last',
  not_within_last: 'not within last',
  before: 'before',
  after: 'after',
  date_range: 'in date range',
};
