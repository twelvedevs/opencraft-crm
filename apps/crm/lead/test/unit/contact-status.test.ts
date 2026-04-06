import { describe, it, expect } from 'vitest';
import {
  applyOptOut,
  removeOptOut,
  applyHardBounce,
} from '../../src/scoring/contact-status.js';

describe('applyOptOut', () => {
  it('active -> sms_opted_out', () => {
    expect(applyOptOut('active')).toBe('sms_opted_out');
  });

  it('email_invalid -> fully_unreachable', () => {
    expect(applyOptOut('email_invalid')).toBe('fully_unreachable');
  });

  it('sms_opted_out -> sms_opted_out (no-op)', () => {
    expect(applyOptOut('sms_opted_out')).toBe('sms_opted_out');
  });

  it('fully_unreachable -> fully_unreachable (no-op)', () => {
    expect(applyOptOut('fully_unreachable')).toBe('fully_unreachable');
  });
});

describe('removeOptOut', () => {
  it('sms_opted_out -> active', () => {
    expect(removeOptOut('sms_opted_out')).toBe('active');
  });

  it('fully_unreachable -> email_invalid', () => {
    expect(removeOptOut('fully_unreachable')).toBe('email_invalid');
  });

  it('active -> active (no-op)', () => {
    expect(removeOptOut('active')).toBe('active');
  });

  it('email_invalid -> email_invalid (no-op)', () => {
    expect(removeOptOut('email_invalid')).toBe('email_invalid');
  });
});

describe('applyHardBounce', () => {
  it('active -> email_invalid', () => {
    expect(applyHardBounce('active')).toBe('email_invalid');
  });

  it('sms_opted_out -> fully_unreachable', () => {
    expect(applyHardBounce('sms_opted_out')).toBe('fully_unreachable');
  });

  it('email_invalid -> email_invalid (no-op)', () => {
    expect(applyHardBounce('email_invalid')).toBe('email_invalid');
  });

  it('fully_unreachable -> fully_unreachable (no-op)', () => {
    expect(applyHardBounce('fully_unreachable')).toBe('fully_unreachable');
  });
});
