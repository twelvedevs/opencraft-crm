export interface StageConfig {
  pipeline: 'new_patient' | 'in_treatment' | 'in_retention';
  timeoutDays: number | null;
  timeoutStage: string | null;
  requiresCallerTimeoutAt: boolean;
  allowedTransitions: string[];
}

export const STAGES: Record<string, StageConfig> = {
  // ── New Patient pipeline ──
  new_lead: {
    pipeline: 'new_patient',
    timeoutDays: null,
    timeoutStage: null,
    requiresCallerTimeoutAt: false,
    allowedTransitions: ['contacted', 'lost'],
  },
  contacted: {
    pipeline: 'new_patient',
    timeoutDays: 5,
    timeoutStage: 'lost',
    requiresCallerTimeoutAt: false,
    allowedTransitions: ['exam_scheduled', 'lost'],
  },
  exam_scheduled: {
    pipeline: 'new_patient',
    timeoutDays: null,
    timeoutStage: null,
    requiresCallerTimeoutAt: false,
    allowedTransitions: ['exam_completed', 'contacted'],
  },
  exam_completed: {
    pipeline: 'new_patient',
    timeoutDays: 7,
    timeoutStage: 'lost',
    requiresCallerTimeoutAt: false,
    allowedTransitions: ['tx_presented', 'lost'],
  },
  tx_presented: {
    pipeline: 'new_patient',
    timeoutDays: 14,
    timeoutStage: 'lost',
    requiresCallerTimeoutAt: false,
    allowedTransitions: ['contract_signed', 'lost'],
  },
  contract_signed: {
    pipeline: 'new_patient',
    timeoutDays: null,
    timeoutStage: null,
    requiresCallerTimeoutAt: false,
    allowedTransitions: [],
  },
  lost: {
    pipeline: 'new_patient',
    timeoutDays: 30,
    timeoutStage: null,
    requiresCallerTimeoutAt: false,
    allowedTransitions: ['contacted'],
  },

  // ── In Treatment pipeline ──
  new_patient: {
    pipeline: 'in_treatment',
    timeoutDays: null,
    timeoutStage: null,
    requiresCallerTimeoutAt: false,
    allowedTransitions: ['in_treatment'],
  },
  in_treatment: {
    pipeline: 'in_treatment',
    timeoutDays: null,
    timeoutStage: null,
    requiresCallerTimeoutAt: false,
    allowedTransitions: ['treatment_complete'],
  },
  treatment_complete: {
    pipeline: 'in_treatment',
    timeoutDays: null,
    timeoutStage: null,
    requiresCallerTimeoutAt: false,
    allowedTransitions: [],
  },

  // ── In Retention pipeline ──
  active_retention: {
    pipeline: 'in_retention',
    timeoutDays: null,
    timeoutStage: null,
    requiresCallerTimeoutAt: false,
    allowedTransitions: ['recall_due'],
  },
  recall_due: {
    pipeline: 'in_retention',
    timeoutDays: null,
    timeoutStage: 'long_term_follow',
    requiresCallerTimeoutAt: true,
    allowedTransitions: ['long_term_follow'],
  },
  long_term_follow: {
    pipeline: 'in_retention',
    timeoutDays: null,
    timeoutStage: null,
    requiresCallerTimeoutAt: false,
    allowedTransitions: ['active_retention'],
  },
};

export function isValidTransition(
  fromStage: string,
  toStage: string,
  override: boolean,
): boolean {
  const config = STAGES[fromStage];
  if (!config) return false;
  if (override) return true;
  return config.allowedTransitions.includes(toStage);
}

export function computeTimeoutAt(
  stage: string,
  enteredAt: Date,
  callerProvidedTimeoutAt?: Date,
): Date | null {
  const config = STAGES[stage];
  if (!config) return null;

  if (config.timeoutDays !== null) {
    return new Date(enteredAt.getTime() + config.timeoutDays * 86_400_000);
  }

  if (config.requiresCallerTimeoutAt) {
    return callerProvidedTimeoutAt ?? null;
  }

  return null;
}

export function getTimeoutStage(stage: string): string | null {
  const config = STAGES[stage];
  if (!config) return null;
  return config.timeoutStage;
}
