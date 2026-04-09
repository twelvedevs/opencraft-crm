/**
 * Campaign state machine — transition guards and validation logic.
 */

const TRANSITIONS: Record<string, Record<string, string>> = {
  draft: {
    submit: 'pending_review',
    cancel: 'cancelled',
  },
  pending_review: {
    approve: 'approved',
    reject: 'draft',
    cancel: 'cancelled',
  },
  approved: {
    schedule: 'scheduled',
    'send-now': 'sending',
    cancel: 'cancelled',
  },
  scheduled: {
    unschedule: 'approved',
    cancel: 'cancelled',
  },
  sending: {
    complete: 'completed',
    'complete-with-errors': 'completed_with_errors',
    fail: 'failed',
  },
};

const LOCKED_FIELDS = new Set([
  'template_id',
  'subject',
  'segment_id',
  'audience_filter',
  'ab_enabled',
  'ab_mode',
  'ab_test_split_pct',
  'ab_variant_a_subject',
  'ab_variant_b_subject',
]);

const LOCKED_STATUSES = new Set([
  'approved',
  'scheduled',
  'sending',
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
]);

export function validateTransition(
  currentStatus: string,
  action: string,
): { ok: boolean; error?: string; httpStatus?: number } {
  const actions = TRANSITIONS[currentStatus];
  if (!actions || !(action in actions)) {
    return {
      ok: false,
      error: `Cannot perform '${action}' on campaign with status '${currentStatus}'`,
      httpStatus: 409,
    };
  }
  return { ok: true };
}

export function targetStatus(currentStatus: string, action: string): string {
  return TRANSITIONS[currentStatus]![action]!;
}

export function validateContentLock(
  currentStatus: string,
  patchFields: string[],
): { ok: boolean; error?: string } {
  if (!LOCKED_STATUSES.has(currentStatus)) {
    return { ok: true };
  }

  const blocked = patchFields.filter((f) => LOCKED_FIELDS.has(f));
  if (blocked.length > 0) {
    return {
      ok: false,
      error: `Content fields [${blocked.join(', ')}] cannot be modified when campaign status is '${currentStatus}'`,
    };
  }

  return { ok: true };
}

export function validateRejectComment(
  comment: string | undefined,
): { ok: boolean; error?: string } {
  if (!comment || comment.trim().length === 0) {
    return { ok: false, error: 'A comment is required when rejecting a campaign' };
  }
  return { ok: true };
}
