import { describe, it, expect } from 'vitest';
import { resolveDryRunPath } from '../../src/services/dry-run-walker.js';
import type { ActionNode } from '../../src/services/action-tree-walker.js';

describe('resolveDryRunPath', () => {
  it('returns single regular node', () => {
    const tree: ActionNode = {
      type: 'send_message',
      params: { template_id: 'tmpl-1' },
    };

    const result = resolveDryRunPath(tree, {});

    expect(result).toEqual([{ action_type: 'send_message', action_params: { template_id: 'tmpl-1' } }]);
  });

  it('returns chain of two nodes', () => {
    const tree: ActionNode = {
      type: 'send_message',
      params: { template_id: 'tmpl-1' },
      next: {
        type: 'send_email',
        params: { subject: 'Hello' },
      },
    };

    const result = resolveDryRunPath(tree, {});

    expect(result).toEqual([
      { action_type: 'send_message', action_params: { template_id: 'tmpl-1' } },
      { action_type: 'send_email', action_params: { subject: 'Hello' } },
    ]);
  });

  it('branch selects if_true path when condition passes', () => {
    const tree: ActionNode = {
      type: 'branch',
      condition: { field: 'status', op: 'eq', value: 'active' },
      if_true: { type: 'send_message', params: { template_id: 'true-tmpl' } },
      if_false: { type: 'send_email', params: { subject: 'False path' } },
    };

    const result = resolveDryRunPath(tree, { status: 'active' });

    expect(result).toEqual([{ action_type: 'send_message', action_params: { template_id: 'true-tmpl' } }]);
  });

  it('branch selects if_false path when condition fails', () => {
    const tree: ActionNode = {
      type: 'branch',
      condition: { field: 'status', op: 'eq', value: 'active' },
      if_true: { type: 'send_message', params: { template_id: 'true-tmpl' } },
      if_false: { type: 'send_email', params: { subject: 'False path' } },
    };

    const result = resolveDryRunPath(tree, { status: 'inactive' });

    expect(result).toEqual([{ action_type: 'send_email', action_params: { subject: 'False path' } }]);
  });

  it('nested branch follows both levels correctly', () => {
    const tree: ActionNode = {
      type: 'branch',
      condition: { field: 'tier', op: 'eq', value: 'premium' },
      if_true: {
        type: 'branch',
        condition: { field: 'opted_in', op: 'eq', value: true },
        if_true: { type: 'send_message', params: { template_id: 'premium-optin' } },
        if_false: { type: 'send_email', params: { subject: 'Premium no optin' } },
      },
      if_false: { type: 'emit_event', params: { event_type: 'standard.flow' } },
    };

    // premium + opted_in → innermost if_true
    const result1 = resolveDryRunPath(tree, { tier: 'premium', opted_in: true });
    expect(result1).toEqual([{ action_type: 'send_message', action_params: { template_id: 'premium-optin' } }]);

    // premium + not opted_in → innermost if_false
    const result2 = resolveDryRunPath(tree, { tier: 'premium', opted_in: false });
    expect(result2).toEqual([{ action_type: 'send_email', action_params: { subject: 'Premium no optin' } }]);

    // not premium → outer if_false
    const result3 = resolveDryRunPath(tree, { tier: 'standard' });
    expect(result3).toEqual([{ action_type: 'emit_event', action_params: { event_type: 'standard.flow' } }]);
  });
});
