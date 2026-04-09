import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

describe('Contract tests — TypeBox payload validation', () => {
  // ─── Outbound: POST /audiences/segments/:id/evaluate ────────────────
  describe('POST /audiences/segments/:id/evaluate payload', () => {
    const schema = Type.Object({
      snapshot_id: Type.String(),
      entities: Type.Array(Type.Any()),
      done: Type.Boolean(),
    });

    it('matches expected shape', () => {
      const fixture = {
        snapshot_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        entities: [{ id: 'lead-1' }, { id: 'lead-2' }],
        done: true,
      };
      expect(Value.Check(schema, fixture)).toBe(true);
    });
  });

  // ─── Outbound: POST /audiences/evaluate (inline) ───────────────────
  describe('POST /audiences/evaluate inline payload', () => {
    const schema = Type.Object({
      snapshot_id: Type.String(),
      filter: Type.Object({}, { additionalProperties: true }),
      entities: Type.Array(Type.Any()),
      snapshot: Type.Boolean(),
      done: Type.Boolean(),
    });

    it('matches expected shape', () => {
      const fixture = {
        snapshot_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        filter: { conditions: [{ field: 'location_id', op: 'eq', value: 'loc-1' }] },
        entities: [{ id: 'lead-1' }],
        snapshot: true,
        done: false,
      };
      expect(Value.Check(schema, fixture)).toBe(true);
    });
  });

  // ─── Outbound: GET /leads response ─────────────────────────────────
  describe('GET /leads response', () => {
    const schema = Type.Object({
      items: Type.Array(
        Type.Object(
          {
            id: Type.String(),
            email: Type.String(),
            location_id: Type.String(),
          },
          { additionalProperties: true },
        ),
      ),
    });

    it('matches expected shape', () => {
      const fixture = {
        items: [
          { id: 'lead-1', email: 'a@b.com', location_id: 'loc-1', first_name: 'Alice' },
          { id: 'lead-2', email: 'c@d.com', location_id: 'loc-2', first_name: 'Bob' },
        ],
      };
      expect(Value.Check(schema, fixture)).toBe(true);
    });
  });

  // ─── Outbound: GET /leads?ids=... response ─────────────────────────
  describe('GET /leads?ids=... response', () => {
    const schema = Type.Object({
      items: Type.Array(
        Type.Object(
          {
            id: Type.String(),
            email: Type.String(),
            location_id: Type.String(),
          },
          { additionalProperties: true },
        ),
      ),
    });

    it('matches expected shape', () => {
      const fixture = {
        items: [
          { id: 'lead-10', email: 'x@y.com', location_id: 'loc-3', first_name: 'Charlie' },
        ],
      };
      expect(Value.Check(schema, fixture)).toBe(true);
    });
  });

  // ─── Outbound: POST /emails/campaigns/send body ────────────────────
  describe('POST /emails/campaigns/send body', () => {
    const schema = Type.Object({
      job_ref: Type.String(),
      location_id: Type.String(),
      template_id: Type.String(),
      subject_template: Type.String(),
      recipients: Type.Array(Type.Any()),
      entity_type: Type.String(),
      entity_id: Type.String(),
    });

    it('matches expected shape', () => {
      const fixture = {
        job_ref: 'camp-1:loc-1:A',
        location_id: 'loc-1',
        template_id: 'tmpl-1',
        subject_template: 'Hello {{first_name}}',
        recipients: [{ id: 'lead-1', email: 'a@b.com', first_name: 'Alice' }],
        entity_type: 'campaign',
        entity_id: 'camp-1',
      };
      expect(Value.Check(schema, fixture)).toBe(true);
    });
  });

  // ─── Outbound: campaign.sent EventBridge payload ───────────────────
  describe('campaign.sent EventBridge payload', () => {
    const schema = Type.Object({
      campaign_id: Type.String(),
      location_id: Type.String(),
      sent_count: Type.Number(),
      template_id: Type.String(),
      completed_at: Type.String(),
    });

    it('matches expected shape', () => {
      const fixture = {
        campaign_id: 'camp-1',
        location_id: 'loc-1',
        sent_count: 50,
        template_id: 'tmpl-1',
        completed_at: '2026-04-09T12:00:00.000Z',
      };
      expect(Value.Check(schema, fixture)).toBe(true);
    });
  });

  // ─── Inbound: email.campaign_completed payload ─────────────────────
  describe('email.campaign_completed payload', () => {
    const schema = Type.Object({
      job_id: Type.String(),
      status: Type.String(),
      sent_count: Type.Number(),
      failed_count: Type.Number(),
      total_recipients: Type.Number(),
      location_id: Type.String(),
      completed_at: Type.String(),
    });

    it('matches expected shape', () => {
      const fixture = {
        job_id: 'email-job-1',
        status: 'completed',
        sent_count: 100,
        failed_count: 0,
        total_recipients: 100,
        location_id: 'loc-1',
        completed_at: '2026-04-09T12:00:00.000Z',
      };
      expect(Value.Check(schema, fixture)).toBe(true);
    });
  });

  // ─── Inbound: email.opened payload ─────────────────────────────────
  describe('email.opened payload', () => {
    const schema = Type.Object({
      campaign_job_id: Type.String(),
      entity_type: Type.String(),
      entity_id: Type.String(),
    });

    it('matches expected shape', () => {
      const fixture = {
        campaign_job_id: 'email-job-1',
        entity_type: 'campaign',
        entity_id: 'camp-1',
      };
      expect(Value.Check(schema, fixture)).toBe(true);
    });
  });

  // ─── Inbound: lead.stage_changed payload ───────────────────────────
  describe('lead.stage_changed payload', () => {
    const schema = Type.Object({
      lead_id: Type.String(),
      stage_to: Type.String(),
      pipeline: Type.String(),
      occurred_at: Type.String(),
    });

    it('matches expected shape', () => {
      const fixture = {
        lead_id: 'lead-1',
        stage_to: 'exam_scheduled',
        pipeline: 'new_patient',
        occurred_at: '2026-04-09T12:00:00.000Z',
      };
      expect(Value.Check(schema, fixture)).toBe(true);
    });
  });
});
