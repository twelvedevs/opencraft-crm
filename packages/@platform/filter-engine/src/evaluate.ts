import type { FilterNode, EvalContext } from './types.js';
import { isGroup, isNot } from './types.js';
import { evaluateBase } from './operators/base.js';

const TEMPORAL_OPS = new Set([
  'within_last',
  'not_within_last',
  'before',
  'after',
  'date_range',
]);

export function evaluate(
  filter: FilterNode,
  entity: Record<string, unknown>,
  context?: EvalContext,
): boolean {
  if (isNot(filter)) {
    return !evaluate(filter.condition, entity, context);
  }

  if (isGroup(filter)) {
    if (filter.op === 'AND') {
      return filter.conditions.every((c) => evaluate(c, entity, context));
    }
    // OR
    return filter.conditions.some((c) => evaluate(c, entity, context));
  }

  // Leaf node
  if (TEMPORAL_OPS.has(filter.op)) {
    if (!context) {
      throw new Error('Temporal operator requires EvalContext');
    }
    // Temporal operators will be handled in US-002
    throw new Error(`Temporal operator requires EvalContext`);
  }

  return evaluateBase(filter, entity);
}
