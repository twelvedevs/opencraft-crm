import type { ConditionNode } from '../types.js';

function resolveField(entity: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = entity;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function evaluateBase(
  node: ConditionNode,
  entity: Record<string, unknown>,
): boolean {
  const fieldValue = resolveField(entity, node.field);

  switch (node.op) {
    case 'exists':
      return fieldValue !== undefined && fieldValue !== null;
    case 'not_exists':
      return fieldValue === undefined || fieldValue === null;
    default:
      break;
  }

  // For all other operators, missing/undefined field returns false
  if (fieldValue === undefined || fieldValue === null) return false;

  switch (node.op) {
    case 'eq':
      return fieldValue === node.value;
    case 'neq':
      return fieldValue !== node.value;
    case 'in':
      return Array.isArray(node.value) && (node.value as unknown[]).includes(fieldValue);
    case 'not_in':
      return Array.isArray(node.value) && !(node.value as unknown[]).includes(fieldValue);
    case 'gt':
      return Number(fieldValue) > Number(node.value);
    case 'gte':
      return Number(fieldValue) >= Number(node.value);
    case 'lt':
      return Number(fieldValue) < Number(node.value);
    case 'lte':
      return Number(fieldValue) <= Number(node.value);
    case 'contains':
      if (typeof fieldValue === 'string') {
        return fieldValue.includes(node.value as string);
      }
      if (Array.isArray(fieldValue)) {
        return fieldValue.includes(node.value);
      }
      return false;
    default:
      throw new Error(`Unknown base operator: ${node.op}`);
  }
}
