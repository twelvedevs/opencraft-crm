import { describe, it, expect } from 'vitest';
import { validateActionTree } from '../../src/services/rule-validator.js';

describe('validateActionTree', () => {
  it('accepts a valid flat action tree', () => {
    const tree = { type: 'send_message', dedup_key: 'k1', template_id: 't1' };
    const result = validateActionTree(tree);
    expect(result.valid).toBe(true);
  });

  it('accepts a valid 3-level nested branch', () => {
    const tree = {
      type: 'branch',
      condition: {},
      if_true: {
        type: 'branch',
        condition: {},
        if_true: {
          type: 'branch',
          condition: {},
          if_true: { type: 'send_email' },
          if_false: { type: 'send_email' },
        },
        if_false: { type: 'send_email' },
      },
      if_false: { type: 'send_email' },
    };
    const result = validateActionTree(tree);
    expect(result.valid).toBe(true);
  });

  it('rejects a 4-level nested branch', () => {
    const tree = {
      type: 'branch',
      condition: {},
      if_true: {
        type: 'branch',
        condition: {},
        if_true: {
          type: 'branch',
          condition: {},
          if_true: {
            type: 'branch',
            condition: {},
            if_true: { type: 'send_email' },
            if_false: { type: 'send_email' },
          },
          if_false: { type: 'send_email' },
        },
        if_false: { type: 'send_email' },
      },
      if_false: { type: 'send_email' },
    };
    const result = validateActionTree(tree);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain('action_tree: branch nesting exceeds maximum depth of 3');
    }
  });

  it('rejects action_tree missing type field', () => {
    const tree = { template_id: 'abc' };
    const result = validateActionTree(tree);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain('action_tree: missing required field type');
    }
  });

  it('rejects unknown action type', () => {
    const tree = { type: 'fly_to_moon' };
    const result = validateActionTree(tree);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain('action_tree: unknown action type fly_to_moon');
    }
  });
});
