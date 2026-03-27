import { type ExecutionContext, resolveValue } from './field-interpolator.js';

export type LeafCondition = {
  field: string;
  op: 'eq' | 'neq' | 'in' | 'not_in' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'exists' | 'not_exists';
  value?: unknown;
};

export type GroupCondition = {
  op: 'AND' | 'OR';
  conditions: Condition[];
};

export type NotCondition = {
  op: 'NOT';
  condition: Condition;
};

export type Condition = LeafCondition | GroupCondition | NotCondition;

function isGroup(c: Condition): c is GroupCondition {
  return c.op === 'AND' || c.op === 'OR';
}

function isNot(c: Condition): c is NotCondition {
  return c.op === 'NOT';
}

function evaluateLeaf(
  leaf: LeafCondition,
  event: Record<string, unknown>,
  execCtx: ExecutionContext,
): boolean {
  const fieldValue = resolveValue(leaf.field, event, execCtx);

  switch (leaf.op) {
    case 'exists':
      return fieldValue !== undefined && fieldValue !== null;
    case 'not_exists':
      return fieldValue === undefined || fieldValue === null;
    case 'eq':
      if (fieldValue === undefined || fieldValue === null) return false;
      return fieldValue === leaf.value;
    case 'neq':
      if (fieldValue === undefined || fieldValue === null) return false;
      return fieldValue !== leaf.value;
    case 'in': {
      if (fieldValue === undefined || fieldValue === null) return false;
      if (!Array.isArray(leaf.value)) return false;
      return (leaf.value as unknown[]).includes(fieldValue);
    }
    case 'not_in': {
      if (fieldValue === undefined || fieldValue === null) return false;
      if (!Array.isArray(leaf.value)) return false;
      return !(leaf.value as unknown[]).includes(fieldValue);
    }
    case 'gt':
      if (fieldValue === undefined || fieldValue === null) return false;
      return Number(fieldValue) > Number(leaf.value);
    case 'gte':
      if (fieldValue === undefined || fieldValue === null) return false;
      return Number(fieldValue) >= Number(leaf.value);
    case 'lt':
      if (fieldValue === undefined || fieldValue === null) return false;
      return Number(fieldValue) < Number(leaf.value);
    case 'lte':
      if (fieldValue === undefined || fieldValue === null) return false;
      return Number(fieldValue) <= Number(leaf.value);
    case 'contains': {
      if (fieldValue === undefined || fieldValue === null) return false;
      if (typeof fieldValue === 'string') {
        return fieldValue.includes(String(leaf.value));
      }
      if (Array.isArray(fieldValue)) {
        return fieldValue.includes(leaf.value);
      }
      return false;
    }
    default:
      return false;
  }
}

export function evaluate(
  condition: Condition | null | undefined,
  event: Record<string, unknown>,
  execCtx: ExecutionContext,
): boolean {
  if (condition == null) return true;

  if (isNot(condition)) {
    return !evaluate(condition.condition, event, execCtx);
  }

  if (isGroup(condition)) {
    if (condition.op === 'AND') {
      for (const sub of condition.conditions) {
        if (!evaluate(sub, event, execCtx)) return false;
      }
      return true;
    }
    // OR
    for (const sub of condition.conditions) {
      if (evaluate(sub, event, execCtx)) return true;
    }
    return false;
  }

  return evaluateLeaf(condition, event, execCtx);
}
