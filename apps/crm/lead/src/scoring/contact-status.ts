/**
 * Pure contact_status state machine — no I/O, no side effects.
 * Tracks SMS opt-out and email hard-bounce states independently.
 */

export type ContactStatus =
  | 'active'
  | 'sms_opted_out'
  | 'email_invalid'
  | 'fully_unreachable';

export function applyOptOut(current: ContactStatus): ContactStatus {
  switch (current) {
    case 'active':
      return 'sms_opted_out';
    case 'email_invalid':
      return 'fully_unreachable';
    case 'sms_opted_out':
    case 'fully_unreachable':
      return current;
  }
}

export function removeOptOut(current: ContactStatus): ContactStatus {
  switch (current) {
    case 'sms_opted_out':
      return 'active';
    case 'fully_unreachable':
      return 'email_invalid';
    case 'active':
    case 'email_invalid':
      return current;
  }
}

export function applyHardBounce(current: ContactStatus): ContactStatus {
  switch (current) {
    case 'active':
      return 'email_invalid';
    case 'sms_opted_out':
      return 'fully_unreachable';
    case 'email_invalid':
    case 'fully_unreachable':
      return current;
  }
}
