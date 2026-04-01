import type { ConditionNode, EvalContext } from '../types.js';

function resolveField(entity: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = entity;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function toDate(val: unknown): Date | null {
  if (val instanceof Date) return val;
  if (typeof val === 'string') {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function evaluateTemporal(
  node: ConditionNode,
  entity: Record<string, unknown>,
  context: EvalContext,
): boolean {
  const fieldValue = resolveField(entity, node.field);
  if (fieldValue === undefined || fieldValue === null) return false;

  const fieldDate = toDate(fieldValue);
  if (!fieldDate) return false;

  switch (node.op) {
    case 'within_last': {
      const { amount, unit } = node.value as { amount: number; unit: 'days' | 'hours' };
      const multiplier = unit === 'days' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
      const threshold = context.now.getTime() - amount * multiplier;
      return fieldDate.getTime() >= threshold;
    }
    case 'not_within_last': {
      const { amount, unit } = node.value as { amount: number; unit: 'days' | 'hours' };
      const multiplier = unit === 'days' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
      const threshold = context.now.getTime() - amount * multiplier;
      return fieldDate.getTime() < threshold;
    }
    case 'before':
      return fieldDate.getTime() < new Date(node.value as string).getTime();
    case 'after':
      return fieldDate.getTime() > new Date(node.value as string).getTime();
    case 'date_range': {
      const { start, end } = node.value as { start: string; end: string };
      return fieldDate.getTime() >= new Date(start).getTime() &&
             fieldDate.getTime() <= new Date(end).getTime();
    }
    default:
      throw new Error(`Unknown temporal operator: ${node.op}`);
  }
}
