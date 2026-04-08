import { describe, it, expect } from 'vitest';
import {
  validateTransition,
  validateContentLock,
  validateRejectComment,
} from '../../src/services/campaign-service.js';

describe('validateTransition', () => {
  describe('valid transitions', () => {
    const validCases: [string, string][] = [
      ['draft', 'submit'],
      ['pending_review', 'approve'],
      ['pending_review', 'reject'],
      ['approved', 'schedule'],
      ['scheduled', 'unschedule'],
      ['approved', 'send-now'],
      ['sending', 'complete'],
      ['sending', 'complete-with-errors'],
      ['sending', 'fail'],
    ];

    it.each(validCases)('%s → %s succeeds', (status, action) => {
      const result = validateTransition(status, action);
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe('cancel transitions', () => {
    const cancellable = ['draft', 'pending_review', 'approved', 'scheduled'];

    it.each(cancellable)('cancel from %s succeeds', (status) => {
      const result = validateTransition(status, 'cancel');
      expect(result.ok).toBe(true);
    });

    const notCancellable = [
      'sending',
      'completed',
      'completed_with_errors',
      'failed',
      'cancelled',
    ];

    it.each(notCancellable)('cancel from %s returns 409', (status) => {
      const result = validateTransition(status, 'cancel');
      expect(result.ok).toBe(false);
      expect(result.httpStatus).toBe(409);
    });
  });

  describe('invalid transitions', () => {
    const invalidCases: [string, string][] = [
      ['draft', 'approve'],
      ['draft', 'reject'],
      ['draft', 'schedule'],
      ['draft', 'send-now'],
      ['pending_review', 'schedule'],
      ['pending_review', 'send-now'],
      ['approved', 'submit'],
      ['approved', 'reject'],
      ['sending', 'submit'],
      ['sending', 'cancel'],
      ['completed', 'submit'],
      ['completed', 'draft'],
      ['completed', 'cancel'],
      ['completed_with_errors', 'cancel'],
      ['failed', 'cancel'],
      ['cancelled', 'submit'],
      ['cancelled', 'draft'],
      ['cancelled', 'cancel'],
    ];

    it.each(invalidCases)('%s → %s returns 409 conflict', (status, action) => {
      const result = validateTransition(status, action);
      expect(result.ok).toBe(false);
      expect(result.httpStatus).toBe(409);
      expect(result.error).toBeDefined();
    });
  });
});

describe('validateContentLock', () => {
  const lockedFields = [
    'template_id',
    'subject',
    'segment_id',
    'audience_filter',
    'ab_enabled',
    'ab_mode',
    'ab_test_split_pct',
    'ab_variant_a_subject',
    'ab_variant_b_subject',
  ];

  describe('draft status — no locking', () => {
    it('allows all fields in draft', () => {
      const result = validateContentLock('draft', lockedFields);
      expect(result.ok).toBe(true);
    });
  });

  describe('pending_review status — no locking', () => {
    it('allows all fields in pending_review', () => {
      const result = validateContentLock('pending_review', lockedFields);
      expect(result.ok).toBe(true);
    });
  });

  describe('approved status — content locked', () => {
    it.each(lockedFields)('blocks %s in approved status', (field) => {
      const result = validateContentLock('approved', [field]);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(field);
    });

    it('allows scheduled_for in approved status', () => {
      const result = validateContentLock('approved', ['scheduled_for']);
      expect(result.ok).toBe(true);
    });

    it('allows name in approved status', () => {
      const result = validateContentLock('approved', ['name']);
      expect(result.ok).toBe(true);
    });
  });

  describe('scheduled status — content locked', () => {
    it('blocks content fields in scheduled status', () => {
      const result = validateContentLock('scheduled', ['template_id', 'subject']);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('template_id');
      expect(result.error).toContain('subject');
    });

    it('allows scheduled_for in scheduled status', () => {
      const result = validateContentLock('scheduled', ['scheduled_for']);
      expect(result.ok).toBe(true);
    });
  });

  describe('terminal statuses — content locked', () => {
    const terminalStatuses = ['completed', 'completed_with_errors', 'failed', 'cancelled'];

    it.each(terminalStatuses)('blocks content fields in %s status', (status) => {
      const result = validateContentLock(status, ['template_id']);
      expect(result.ok).toBe(false);
    });
  });
});

describe('validateRejectComment', () => {
  it('returns error when comment is undefined', () => {
    const result = validateRejectComment(undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error when comment is empty string', () => {
    const result = validateRejectComment('');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns error when comment is whitespace only', () => {
    const result = validateRejectComment('   ');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('passes with valid comment', () => {
    const result = validateRejectComment('Needs changes to the subject line');
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });
});
