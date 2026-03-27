import { describe, it, expect } from 'vitest';
import { walkActionTree } from '../../src/services/action-tree-walker.js';
import type { ActionNode } from '../../src/services/action-tree-walker.js';

const EXEC_ID = 'exec-123';

describe('walkActionTree', () => {
  it('single regular node (no next): returns 1 step with correct fields, no _next_step_id', () => {
    const tree: ActionNode = {
      type: 'send_message',
      params: { to: '+1234567890' },
    };
    const steps = walkActionTree(tree, EXEC_ID);
    expect(steps).toHaveLength(1);
    expect(steps[0].action_type).toBe('send_message');
    expect(steps[0].action_params['to']).toBe('+1234567890');
    expect(steps[0].action_params['_next_step_id']).toBeUndefined();
    expect(steps[0].execution_id).toBe(EXEC_ID);
    expect(steps[0].status).toBe('pending');
  });

  it('linear chain of 3 regular nodes: correct next step linking', () => {
    const tree: ActionNode = {
      type: 'send_message',
      params: { msg: 'first' },
      next: {
        type: 'send_email',
        params: { subject: 'second' },
        next: {
          type: 'call_ai',
          params: { prompt: 'third' },
        },
      },
    };
    const steps = walkActionTree(tree, EXEC_ID);
    expect(steps).toHaveLength(3);
    expect(steps[0].action_params['_next_step_id']).toBe(steps[1].id);
    expect(steps[1].action_params['_next_step_id']).toBe(steps[2].id);
    expect(steps[2].action_params['_next_step_id']).toBeUndefined();
  });

  it('branch node with two leaf children: 3 steps with correct routing metadata', () => {
    const tree: ActionNode = {
      type: 'branch',
      condition: { field: 'status', op: 'eq', value: 'active' },
      if_true: { type: 'send_message', params: { msg: 'yes' } },
      if_false: { type: 'send_email', params: { subject: 'no' } },
    };
    const steps = walkActionTree(tree, EXEC_ID);
    expect(steps).toHaveLength(3);
    expect(steps[0].action_type).toBe('branch');
    expect(steps[0].action_params['_if_true_step_id']).toBe(steps[1].id);
    expect(steps[0].action_params['_if_false_step_id']).toBe(steps[2].id);
    expect(steps[0].action_params['_if_true_subtree_ids']).toEqual([steps[1].id]);
    expect(steps[0].action_params['_if_false_subtree_ids']).toEqual([steps[2].id]);
  });

  it('nested branch (outer if_true is itself a branch): 7 total steps, correct subtree IDs', () => {
    // outer branch: if_true = inner branch (with two leaves), if_false = single leaf
    const tree: ActionNode = {
      type: 'branch',
      condition: { field: 'a', op: 'eq', value: 1 },
      if_true: {
        type: 'branch',
        condition: { field: 'b', op: 'eq', value: 2 },
        if_true: { type: 'send_message', params: {} },
        if_false: { type: 'send_email', params: {} },
      },
      if_false: { type: 'call_ai', params: {} },
    };
    const steps = walkActionTree(tree, EXEC_ID);
    expect(steps).toHaveLength(5);

    const outer = steps[0];
    expect(outer.action_type).toBe('branch');

    // if_true subtree: inner branch + its 2 children = 3 IDs
    const trueSubtree = outer.action_params['_if_true_subtree_ids'] as string[];
    expect(trueSubtree).toHaveLength(3);

    // if_false subtree: single leaf = 1 ID
    const falseSubtree = outer.action_params['_if_false_subtree_ids'] as string[];
    expect(falseSubtree).toHaveLength(1);

    // outer._if_true_step_id === first element of trueSubtree
    expect(outer.action_params['_if_true_step_id']).toBe(trueSubtree[0]);
    expect(outer.action_params['_if_false_step_id']).toBe(falseSubtree[0]);
  });

  it('all returned steps have status "pending" and correct execution_id', () => {
    const tree: ActionNode = {
      type: 'branch',
      condition: {},
      if_true: {
        type: 'send_message',
        params: {},
        next: { type: 'send_email', params: {} },
      },
      if_false: { type: 'call_ai', params: {} },
    };
    const steps = walkActionTree(tree, EXEC_ID);
    for (const step of steps) {
      expect(step.status).toBe('pending');
      expect(step.execution_id).toBe(EXEC_ID);
    }
  });

  it('all IDs are non-empty strings and globally unique', () => {
    const tree: ActionNode = {
      type: 'branch',
      condition: {},
      if_true: {
        type: 'send_message',
        params: {},
        next: { type: 'send_email', params: {} },
      },
      if_false: {
        type: 'call_ai',
        params: {},
        next: { type: 'emit_event', params: {} },
      },
    };
    const steps = walkActionTree(tree, EXEC_ID);
    const ids = steps.map((s) => s.id);
    for (const id of ids) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});
