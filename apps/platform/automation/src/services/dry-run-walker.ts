import { type Condition, evaluate } from './condition-evaluator.js';
import type { ActionNode } from './action-tree-walker.js';
import type { ExecutionContext } from './field-interpolator.js';

export interface DryRunStep {
  action_type: string;
  action_params: Record<string, unknown>;
}

const DUMMY_EXEC_CTX: ExecutionContext = {
  event_id: 'dry-run',
  execution_id: 'dry-run',
  rule_id: 'dry-run',
  rule_version: 0,
};

export function resolveDryRunPath(
  tree: ActionNode,
  payload: Record<string, unknown>,
): DryRunStep[] {
  if (tree.type === 'branch') {
    const matches = evaluate(
      tree.condition as Condition | null | undefined,
      payload,
      DUMMY_EXEC_CTX,
    );
    const next = matches ? tree.if_true : tree.if_false;
    return resolveDryRunPath(next, payload);
  }

  const step: DryRunStep = {
    action_type: tree.type,
    action_params: tree.params,
  };

  if (tree.next) {
    return [step, ...resolveDryRunPath(tree.next, payload)];
  }

  return [step];
}
