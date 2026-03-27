import { randomUUID } from 'node:crypto';

export type RegularActionNode = {
  type: 'send_message' | 'send_email' | 'call_ai' | 'enroll_sequence' | 'emit_event' | 'call_webhook';
  params: Record<string, unknown>;
  next?: ActionNode;
};

export type BranchActionNode = {
  type: 'branch';
  condition: unknown;
  if_true: ActionNode;
  if_false: ActionNode;
};

export type ActionNode = RegularActionNode | BranchActionNode;

export interface StepRecord {
  id: string;
  execution_id: string;
  action_type: string;
  action_params: Record<string, unknown>;
  status: 'pending';
}

export function walkActionTree(tree: ActionNode, executionId: string): StepRecord[] {
  if (tree.type === 'branch') {
    const id = randomUUID();
    const trueSteps = walkActionTree(tree.if_true, executionId);
    const falseSteps = walkActionTree(tree.if_false, executionId);
    const branchStep: StepRecord = {
      id,
      execution_id: executionId,
      action_type: 'branch',
      action_params: {
        condition: tree.condition,
        _if_true_step_id: trueSteps[0].id,
        _if_false_step_id: falseSteps[0].id,
        _if_true_subtree_ids: trueSteps.map((s) => s.id),
        _if_false_subtree_ids: falseSteps.map((s) => s.id),
      },
      status: 'pending',
    };
    return [branchStep, ...trueSteps, ...falseSteps];
  }

  const id = randomUUID();
  const action_params: Record<string, unknown> = { ...(tree.params ?? {}) };

  if (tree.next) {
    const nextSteps = walkActionTree(tree.next, executionId);
    action_params['_next_step_id'] = nextSteps[0].id;
    const currentStep: StepRecord = {
      id,
      execution_id: executionId,
      action_type: tree.type,
      action_params,
      status: 'pending',
    };
    return [currentStep, ...nextSteps];
  }

  return [
    {
      id,
      execution_id: executionId,
      action_type: tree.type,
      action_params,
      status: 'pending',
    },
  ];
}
