import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/* ------------------------------------------------------------------ */
/*  Contract schemas                                                   */
/* ------------------------------------------------------------------ */

/**
 * Incoming lead.created payload — the referral service REQUIRES
 * referrer_id, referrer_type, and referral_code to be present
 * (even if null) so it can decide whether to create a referral.
 */
const LeadCreatedPayloadContract = Type.Object({
  lead_id: Type.String(),
  location_id: Type.String(),
  channel: Type.String(),
  current_pipeline: Type.String(),
  current_stage: Type.Union([Type.String(), Type.Null()]),
  referrer_id: Type.Union([Type.String(), Type.Null()]),
  referrer_type: Type.Union([Type.String(), Type.Null()]),
  referral_code: Type.Union([Type.String(), Type.Null()]),
});

/** Outgoing referral.converted payload — all fields required strings. */
const ReferralConvertedPayloadContract = Type.Object({
  referral_id: Type.String(),
  lead_id: Type.String(),
  referrer_id: Type.String(),
  referrer_type: Type.String(),
  location_id: Type.String(),
  converted_at: Type.String(),
});

/**
 * Outgoing referrer.created payload — all fields required.
 * referral_link_url must contain the redirect endpoint path
 * `/referrals/r/<code>`, NOT a landing-page URL with `?ref=`.
 */
const ReferrerCreatedPayloadContract = Type.Object({
  referrer_id: Type.String(),
  referrer_type: Type.String(),
  lead_id: Type.String(),
  location_id: Type.String(),
  referral_link_id: Type.String(),
  referral_code: Type.String(),
  referral_link_url: Type.String({ pattern: '/referrals/r/[A-Za-z0-9]+' }),
  created_at: Type.String(),
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('Event payload contracts', () => {
  /* ---------- incoming lead.created ---------- */
  describe('incoming lead.created', () => {
    const validPayload = {
      lead_id: 'lead-1',
      location_id: 'loc-1',
      channel: 'website',
      current_pipeline: 'new_patient',
      current_stage: 'new_lead',
      referrer_id: 'ref-1',
      referrer_type: 'patient',
      referral_code: 'ABC12345',
    };

    it('accepts a complete payload with referral fields', () => {
      expect(Value.Check(LeadCreatedPayloadContract, validPayload)).toBe(true);
    });

    it('accepts payload with null referral fields', () => {
      const payload = {
        ...validPayload,
        current_stage: null,
        referrer_id: null,
        referrer_type: null,
        referral_code: null,
      };
      expect(Value.Check(LeadCreatedPayloadContract, payload)).toBe(true);
    });

    it('rejects payload missing referrer_id', () => {
      const { referrer_id: _, ...payload } = validPayload;
      expect(Value.Check(LeadCreatedPayloadContract, payload)).toBe(false);
    });

    it('rejects payload missing referrer_type', () => {
      const { referrer_type: _, ...payload } = validPayload;
      expect(Value.Check(LeadCreatedPayloadContract, payload)).toBe(false);
    });

    it('rejects payload missing referral_code', () => {
      const { referral_code: _, ...payload } = validPayload;
      expect(Value.Check(LeadCreatedPayloadContract, payload)).toBe(false);
    });
  });

  /* ---------- outgoing referral.converted ---------- */
  describe('outgoing referral.converted', () => {
    const validPayload = {
      referral_id: 'ref-1',
      lead_id: 'lead-1',
      referrer_id: 'referrer-1',
      referrer_type: 'patient',
      location_id: 'loc-1',
      converted_at: '2026-04-09T18:00:00Z',
    };

    it('accepts a complete payload', () => {
      expect(Value.Check(ReferralConvertedPayloadContract, validPayload)).toBe(true);
    });

    it('rejects when any required field is missing', () => {
      const requiredFields = ['referral_id', 'lead_id', 'referrer_id', 'referrer_type', 'location_id', 'converted_at'] as const;
      for (const field of requiredFields) {
        const payload: Record<string, unknown> = { ...validPayload };
        delete payload[field];
        expect(Value.Check(ReferralConvertedPayloadContract, payload)).toBe(false);
      }
    });
  });

  /* ---------- outgoing referrer.created ---------- */
  describe('outgoing referrer.created', () => {
    const validPayload = {
      referrer_id: 'referrer-1',
      referrer_type: 'patient',
      lead_id: 'lead-1',
      location_id: 'loc-1',
      referral_link_id: 'link-1',
      referral_code: 'ABC12345',
      referral_link_url: 'https://api.example.com/referrals/r/ABC12345',
      created_at: '2026-04-09T18:00:00Z',
    };

    it('accepts a complete payload', () => {
      expect(Value.Check(ReferrerCreatedPayloadContract, validPayload)).toBe(true);
    });

    it('rejects when any required field is missing', () => {
      const requiredFields = ['referrer_id', 'lead_id', 'location_id', 'referral_link_id', 'referral_code', 'referral_link_url'] as const;
      for (const field of requiredFields) {
        const payload: Record<string, unknown> = { ...validPayload };
        delete payload[field];
        expect(Value.Check(ReferrerCreatedPayloadContract, payload)).toBe(false);
      }
    });

    it('referral_link_url must contain /referrals/r/<code> path', () => {
      expect(Value.Check(ReferrerCreatedPayloadContract, validPayload)).toBe(true);

      // A landing-page URL with ?ref= is NOT valid
      const badPayload = {
        ...validPayload,
        referral_link_url: 'https://example.com/landing?ref=ABC12345',
      };
      expect(Value.Check(ReferrerCreatedPayloadContract, badPayload)).toBe(false);
    });
  });
});
