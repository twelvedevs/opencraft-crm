/**
 * Pure lead scoring function — no I/O, no side effects.
 * Computes a priority score (0–100) from lead state and event context.
 */

/** Stage time limits in minutes. null = no urgency limit. */
export const STAGE_TIME_LIMITS: Record<string, number | null> = {
  new_lead: 2 * 60,
  contacted: 5 * 24 * 60,
  exam_scheduled: null, // uses scheduledAt
  exam_completed: 7 * 24 * 60,
  tx_presented: 14 * 24 * 60,
  lost: 30 * 24 * 60,
};

/** Base score contribution from pipeline stage. */
export const STAGE_VALUE_WEIGHTS: Record<string, number> = {
  tx_presented: 40,
  exam_completed: 30,
  exam_scheduled: 20,
  contacted: 10,
  new_lead: 5,
};

export type ScoreParams = {
  lead: {
    current_stage: string | null;
    current_pipeline: string;
    contact_status: string;
    last_activity_at: Date | null;
  };
  eventType: string;
  lastInboundAt?: Date | null;
  scheduledAt?: Date | null;
};

export function calculateScore(params: ScoreParams): number {
  const { lead, eventType, lastInboundAt, scheduledAt } = params;
  const now = new Date();

  // Base score from stage weight
  let score = STAGE_VALUE_WEIGHTS[lead.current_stage ?? ''] ?? 0;

  // Urgency boost
  if (lead.current_stage) {
    const limit = STAGE_TIME_LIMITS[lead.current_stage];
    if (lead.current_stage === 'exam_scheduled' && scheduledAt) {
      // For exam_scheduled, boost if appointment is past
      if (scheduledAt.getTime() < now.getTime()) {
        score += 20;
      }
    } else if (limit != null && lead.last_activity_at) {
      const elapsedMinutes =
        (now.getTime() - lead.last_activity_at.getTime()) / 60000;
      const remainingMinutes = limit - elapsedMinutes;
      if (remainingMinutes < limit * 0.2) {
        score += 20;
      }
    }
  }

  // Inbound engagement boost
  if (eventType === 'inbound_message.received') {
    score += 15;
  }

  // Inbound age urgency
  if (lastInboundAt) {
    const daysSinceInbound =
      (now.getTime() - lastInboundAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceInbound > 3) {
      score += 10;
    }
  }

  // Contact status penalties
  if (lead.contact_status === 'sms_opted_out') {
    score -= 10;
  }
  if (lead.contact_status === 'email_invalid') {
    score -= 10;
  }

  // Clamp 0–100
  score = Math.max(0, Math.min(100, score));

  // fully_unreachable floor
  if (lead.contact_status === 'fully_unreachable') {
    score = Math.min(score, 5);
  }

  return score;
}
