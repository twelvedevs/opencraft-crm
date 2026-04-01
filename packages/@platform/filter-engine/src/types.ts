export interface ConditionNode {
  field: string;
  op:
    | 'eq'
    | 'neq'
    | 'in'
    | 'not_in'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'contains'
    | 'exists'
    | 'not_exists'
    | 'within_last'
    | 'not_within_last'
    | 'before'
    | 'after'
    | 'date_range';
  value?: unknown;
}

export interface GroupNode {
  op: 'AND' | 'OR';
  conditions: FilterNode[];
}

export interface NotNode {
  op: 'NOT';
  condition: FilterNode;
}

export type FilterNode = ConditionNode | GroupNode | NotNode;

export interface EvalContext {
  now: Date;
}

export function isGroup(node: FilterNode): node is GroupNode {
  return node.op === 'AND' || node.op === 'OR';
}

export function isNot(node: FilterNode): node is NotNode {
  return node.op === 'NOT';
}

export function isLeaf(node: FilterNode): node is ConditionNode {
  return !isGroup(node) && !isNot(node);
}
