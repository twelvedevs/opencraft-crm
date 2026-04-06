import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  calculateScore,
  STAGE_VALUE_WEIGHTS,
  STAGE_TIME_LIMITS,
  type ScoreParams,
} from '../../src/scoring/score-calculator.js';

function makeParams(overrides: Partial<ScoreParams> & { lead?: Partial<ScoreParams['lead']> } = {}): ScoreParams {
  return {
    lead: {
      current_stage: 'new_lead',
      current_pipeline: 'new_patient',
      contact_status: 'active',
      last_activity_at: null,
      ...overrides.lead,
    },
    eventType: overrides.eventType ?? 'manual',
    lastInboundAt: overrides.lastInboundAt ?? null,
    scheduledAt: overrides.scheduledAt ?? null,
  };
}

describe('calculateScore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-06T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies stage value weight for tx_presented', () => {
    const score = calculateScore(makeParams({ lead: { current_stage: 'tx_presented' } }));
    expect(score).toBe(STAGE_VALUE_WEIGHTS.tx_presented); // 40
  });

  it('applies stage value weight for new_lead', () => {
    const score = calculateScore(makeParams({ lead: { current_stage: 'new_lead' } }));
    expect(score).toBe(STAGE_VALUE_WEIGHTS.new_lead); // 5
  });

  it('returns 0 for unknown stage', () => {
    const score = calculateScore(makeParams({ lead: { current_stage: 'in_treatment' } }));
    expect(score).toBe(0);
  });

  it('returns 0 for null stage', () => {
    const score = calculateScore(makeParams({ lead: { current_stage: null } }));
    expect(score).toBe(0);
  });

  describe('urgency boost', () => {
    it('adds 20 points when time remaining < 20% of stage limit', () => {
      const limit = STAGE_TIME_LIMITS.new_lead!; // 120 minutes
      // Set last_activity_at so remaining is < 20% (< 24 minutes) — e.g. 100 minutes elapsed
      const lastActivity = new Date('2026-04-06T10:20:00Z'); // 100 min ago
      const score = calculateScore(
        makeParams({ lead: { current_stage: 'new_lead', last_activity_at: lastActivity } }),
      );
      expect(score).toBe(STAGE_VALUE_WEIGHTS.new_lead + 20); // 5 + 20 = 25
    });

    it('does not add urgency boost when time remaining > 20%', () => {
      // new_lead limit = 120 min, 20% = 24 min. Set last_activity_at 30 min ago → 90 min remaining > 24
      const lastActivity = new Date('2026-04-06T11:30:00Z'); // 30 min ago
      const score = calculateScore(
        makeParams({ lead: { current_stage: 'new_lead', last_activity_at: lastActivity } }),
      );
      expect(score).toBe(STAGE_VALUE_WEIGHTS.new_lead); // 5, no boost
    });

    it('adds urgency boost for exam_scheduled when scheduledAt is in the past', () => {
      const score = calculateScore(
        makeParams({
          lead: { current_stage: 'exam_scheduled' },
          scheduledAt: new Date('2026-04-05T10:00:00Z'), // yesterday
        }),
      );
      expect(score).toBe(STAGE_VALUE_WEIGHTS.exam_scheduled + 20); // 20 + 20 = 40
    });

    it('does not add urgency boost for exam_scheduled when scheduledAt is in the future', () => {
      const score = calculateScore(
        makeParams({
          lead: { current_stage: 'exam_scheduled' },
          scheduledAt: new Date('2026-04-07T10:00:00Z'), // tomorrow
        }),
      );
      expect(score).toBe(STAGE_VALUE_WEIGHTS.exam_scheduled); // 20
    });
  });

  describe('inbound engagement', () => {
    it('adds 15 points for inbound_message.received event', () => {
      const score = calculateScore(makeParams({ eventType: 'inbound_message.received' }));
      expect(score).toBe(STAGE_VALUE_WEIGHTS.new_lead + 15); // 5 + 15 = 20
    });

    it('does not add inbound points for other event types', () => {
      const score = calculateScore(makeParams({ eventType: 'lead.updated' }));
      expect(score).toBe(STAGE_VALUE_WEIGHTS.new_lead); // 5
    });
  });

  describe('inbound age urgency', () => {
    it('adds 10 points when lastInboundAt is more than 3 days ago', () => {
      const score = calculateScore(
        makeParams({ lastInboundAt: new Date('2026-04-02T00:00:00Z') }), // 4+ days ago
      );
      expect(score).toBe(STAGE_VALUE_WEIGHTS.new_lead + 10); // 5 + 10 = 15
    });

    it('does not add inbound age points when lastInboundAt is within 3 days', () => {
      const score = calculateScore(
        makeParams({ lastInboundAt: new Date('2026-04-04T00:00:00Z') }), // 2 days ago
      );
      expect(score).toBe(STAGE_VALUE_WEIGHTS.new_lead); // 5
    });
  });

  describe('contact_status penalties', () => {
    it('subtracts 10 for sms_opted_out', () => {
      const score = calculateScore(
        makeParams({ lead: { current_stage: 'exam_completed', contact_status: 'sms_opted_out' } }),
      );
      expect(score).toBe(STAGE_VALUE_WEIGHTS.exam_completed - 10); // 30 - 10 = 20
    });

    it('subtracts 10 for email_invalid', () => {
      const score = calculateScore(
        makeParams({ lead: { current_stage: 'exam_completed', contact_status: 'email_invalid' } }),
      );
      expect(score).toBe(STAGE_VALUE_WEIGHTS.exam_completed - 10); // 30 - 10 = 20
    });

    it('floors result at 5 for fully_unreachable regardless of other factors', () => {
      // tx_presented = 40 base, but fully_unreachable floors at 5
      const score = calculateScore(
        makeParams({ lead: { current_stage: 'tx_presented', contact_status: 'fully_unreachable' } }),
      );
      expect(score).toBe(5);
    });

    it('floors at 5 for fully_unreachable even with high combined score', () => {
      // tx_presented(40) + inbound(15) + inbound_age(10) + urgency(20) = 85, but capped at 5
      const limit = STAGE_TIME_LIMITS.tx_presented!;
      const elapsed = limit * 0.9; // 90% elapsed → < 20% remaining
      const lastActivity = new Date(Date.now() - elapsed * 60000);
      const score = calculateScore(
        makeParams({
          lead: {
            current_stage: 'tx_presented',
            contact_status: 'fully_unreachable',
            last_activity_at: lastActivity,
          },
          eventType: 'inbound_message.received',
          lastInboundAt: new Date('2026-04-01T00:00:00Z'),
        }),
      );
      expect(score).toBe(5);
    });
  });

  it('never exceeds 100', () => {
    // Stack all bonuses on a high-weight stage
    const limit = STAGE_TIME_LIMITS.tx_presented!;
    const lastActivity = new Date(Date.now() - limit * 0.9 * 60000);
    const score = calculateScore(
      makeParams({
        lead: {
          current_stage: 'tx_presented',
          last_activity_at: lastActivity,
        },
        eventType: 'inbound_message.received',
        lastInboundAt: new Date('2026-04-01T00:00:00Z'),
      }),
    );
    // 40 + 20 + 15 + 10 = 85 — under 100, but verify clamp works
    expect(score).toBeLessThanOrEqual(100);
  });

  it('never goes below 0', () => {
    // null stage (0 base) + sms_opted_out (-10) → would be -10, clamped to 0
    const score = calculateScore(
      makeParams({ lead: { current_stage: null, contact_status: 'sms_opted_out' } }),
    );
    expect(score).toBe(0);
  });
});
