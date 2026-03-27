export type ValidationResult = { valid: true } | { valid: false; errors: string[] };

const VALID_ACTION_TYPES = new Set([
  'send_message',
  'send_email',
  'call_ai',
  'enroll_sequence',
  'emit_event',
  'call_webhook',
  'branch',
]);

function validateNode(node: unknown, depth: number, errors: string[]): void {
  if (typeof node !== 'object' || node === null) {
    errors.push('action_tree: missing required field type');
    return;
  }

  const n = node as Record<string, unknown>;

  if (!('type' in n)) {
    errors.push('action_tree: missing required field type');
    return;
  }

  const type = n['type'];

  if (typeof type !== 'string' || !VALID_ACTION_TYPES.has(type)) {
    errors.push(`action_tree: unknown action type ${type}`);
    return;
  }

  if (type === 'send_message' && !n['dedup_key']) {
    console.warn(
      'action_tree: send_message node missing dedup_key — proceeding without idempotency protection',
    );
  }

  if (type === 'branch') {
    if (depth >= 4) {
      errors.push('action_tree: branch nesting exceeds maximum depth of 3');
      return;
    }

    if (n['if_true'] !== undefined) {
      validateNode(n['if_true'], depth + 1, errors);
    }
    if (n['if_false'] !== undefined) {
      validateNode(n['if_false'], depth + 1, errors);
    }
  }
}

export function validateActionTree(tree: unknown): ValidationResult {
  const errors: string[] = [];
  validateNode(tree, 1, errors);

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true };
}
