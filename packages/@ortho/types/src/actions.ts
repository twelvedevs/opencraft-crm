export type AutomationActionType =
  | 'send_message'
  | 'send_email'
  | 'call_ai'
  | 'enroll_sequence'
  | 'emit_event'
  | 'call_webhook'
  | 'branch'
  | 'unenroll_sequence';
