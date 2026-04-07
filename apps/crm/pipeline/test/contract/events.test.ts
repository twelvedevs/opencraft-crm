import { describe, it, expect, beforeEach } from 'vitest';
import { MockDriver, EventBusImpl } from '@ortho/event-bus';
import {
  publishStageChanged,
  publishConverted,
  publishStageTimeout,
  publishArchived,
} from '../../src/events/publisher.js';

describe('Event contract tests', () => {
  let mockDriver: MockDriver;
  let eventBus: EventBusImpl;

  beforeEach(() => {
    mockDriver = new MockDriver();
    eventBus = new EventBusImpl(mockDriver);
  });

  describe('lead.stage_changed', () => {
    it('includes all envelope and payload fields', async () => {
      const now = new Date().toISOString();
      await publishStageChanged(eventBus, 'corr-1', {
        membership_id: 'mem-1',
        lead_id: 'lead-1',
        location_id: 'loc-1',
        pipeline: 'new_patient',
        stage_from: 'new_lead',
        stage_to: 'contacted',
        override: false,
        triggered_by: 'user-1',
        reason: 'manual',
        timeout_at: now,
        transitioned_at: now,
        time_in_stage_seconds: 120,
        response_time_seconds: 60,
      });

      expect(mockDriver.published).toHaveLength(1);
      const event = mockDriver.published[0]!;

      // Envelope fields
      expect(event.event_id).toEqual(expect.any(String));
      expect(event.event_id.length).toBeGreaterThan(0);
      expect(event.event_type).toBe('lead.stage_changed');
      expect(event.entity_type).toBe('lead');
      expect(event.entity_id).toBe('lead-1');
      expect(event.schema_version).toBe('1.0');
      expect(event.correlation_id).toBe('corr-1');

      // Payload fields
      const p = event.payload as Record<string, unknown>;
      expect(p).toMatchObject({
        membership_id: 'mem-1',
        lead_id: 'lead-1',
        location_id: 'loc-1',
        pipeline: 'new_patient',
        stage_from: 'new_lead',
        stage_to: 'contacted',
        override: false,
        triggered_by: 'user-1',
        reason: 'manual',
        timeout_at: now,
        transitioned_at: now,
        time_in_stage_seconds: 120,
        response_time_seconds: 60,
      });
    });

    it('has null time_in_stage_seconds when stage_from is null', async () => {
      const now = new Date().toISOString();
      await publishStageChanged(eventBus, 'corr-2', {
        membership_id: 'mem-2',
        lead_id: 'lead-2',
        location_id: 'loc-2',
        pipeline: 'new_patient',
        stage_from: null,
        stage_to: 'new_lead',
        override: false,
        triggered_by: 'user-1',
        reason: 'enrollment',
        timeout_at: null,
        transitioned_at: now,
        time_in_stage_seconds: null,
        response_time_seconds: null,
      });

      const p = mockDriver.published[0]!.payload as Record<string, unknown>;
      expect(p.stage_from).toBeNull();
      expect(p.time_in_stage_seconds).toBeNull();
    });

    it('has response_time_seconds when stage_to=contacted, stage_from is not null, and triggered_by is not null', async () => {
      const now = new Date().toISOString();
      await publishStageChanged(eventBus, 'corr-3', {
        membership_id: 'mem-3',
        lead_id: 'lead-3',
        location_id: 'loc-3',
        pipeline: 'new_patient',
        stage_from: 'new_lead',
        stage_to: 'contacted',
        override: false,
        triggered_by: 'user-1',
        reason: 'manual',
        timeout_at: now,
        transitioned_at: now,
        time_in_stage_seconds: 300,
        response_time_seconds: 300,
      });

      const p = mockDriver.published[0]!.payload as Record<string, unknown>;
      expect(p.response_time_seconds).toEqual(expect.any(Number));
    });

    it('has null response_time_seconds when triggered_by is null', async () => {
      const now = new Date().toISOString();
      await publishStageChanged(eventBus, 'corr-4', {
        membership_id: 'mem-4',
        lead_id: 'lead-4',
        location_id: 'loc-4',
        pipeline: 'new_patient',
        stage_from: 'new_lead',
        stage_to: 'contacted',
        override: false,
        triggered_by: null,
        reason: 'timeout',
        timeout_at: now,
        transitioned_at: now,
        time_in_stage_seconds: 300,
        response_time_seconds: null,
      });

      const p = mockDriver.published[0]!.payload as Record<string, unknown>;
      expect(p.response_time_seconds).toBeNull();
    });
  });

  describe('lead.converted', () => {
    it('includes all envelope and payload fields', async () => {
      const now = new Date().toISOString();
      await publishConverted(eventBus, 'corr-5', {
        lead_id: 'lead-5',
        location_id: 'loc-5',
        from_pipeline: 'new_patient',
        from_stage: 'contract_signed',
        to_pipeline: 'in_treatment',
        to_stage: 'new_patient',
        new_membership_id: 'mem-new',
        channel: 'web',
        triggered_by: 'user-5',
        converted_at: now,
      });

      expect(mockDriver.published).toHaveLength(1);
      const event = mockDriver.published[0]!;

      // Envelope
      expect(event.event_id).toEqual(expect.any(String));
      expect(event.event_id.length).toBeGreaterThan(0);
      expect(event.event_type).toBe('lead.converted');
      expect(event.entity_type).toBe('lead');
      expect(event.entity_id).toBe('lead-5');
      expect(event.schema_version).toBe('1.0');
      expect(event.correlation_id).toBe('corr-5');

      // Payload
      const p = event.payload as Record<string, unknown>;
      expect(p).toMatchObject({
        lead_id: 'lead-5',
        location_id: 'loc-5',
        from_pipeline: 'new_patient',
        from_stage: 'contract_signed',
        to_pipeline: 'in_treatment',
        to_stage: 'new_patient',
        new_membership_id: 'mem-new',
        channel: 'web',
        triggered_by: 'user-5',
        converted_at: now,
      });
    });
  });

  describe('lead.stage_timeout', () => {
    it('includes all envelope and payload fields', async () => {
      const now = new Date().toISOString();
      await publishStageTimeout(eventBus, 'corr-6', {
        membership_id: 'mem-6',
        lead_id: 'lead-6',
        location_id: 'loc-6',
        pipeline: 'new_patient',
        timed_out_stage: 'contacted',
        new_stage: 'lost',
        timed_out_at: now,
        exceeded_by_seconds: 3600,
      });

      expect(mockDriver.published).toHaveLength(1);
      const event = mockDriver.published[0]!;

      // Envelope
      expect(event.event_id).toEqual(expect.any(String));
      expect(event.event_id.length).toBeGreaterThan(0);
      expect(event.event_type).toBe('lead.stage_timeout');
      expect(event.entity_type).toBe('lead');
      expect(event.entity_id).toBe('lead-6');
      expect(event.schema_version).toBe('1.0');
      expect(event.correlation_id).toBe('corr-6');

      // Payload
      const p = event.payload as Record<string, unknown>;
      expect(p).toMatchObject({
        membership_id: 'mem-6',
        lead_id: 'lead-6',
        location_id: 'loc-6',
        pipeline: 'new_patient',
        timed_out_stage: 'contacted',
        new_stage: 'lost',
        timed_out_at: now,
        exceeded_by_seconds: 3600,
      });
    });
  });

  describe('lead.archived', () => {
    it('includes all envelope and payload fields', async () => {
      const now = new Date().toISOString();
      await publishArchived(eventBus, 'corr-7', {
        membership_id: 'mem-7',
        lead_id: 'lead-7',
        location_id: 'loc-7',
        pipeline: 'new_patient',
        archived_at: now,
      });

      expect(mockDriver.published).toHaveLength(1);
      const event = mockDriver.published[0]!;

      // Envelope
      expect(event.event_id).toEqual(expect.any(String));
      expect(event.event_id.length).toBeGreaterThan(0);
      expect(event.event_type).toBe('lead.archived');
      expect(event.entity_type).toBe('lead');
      expect(event.entity_id).toBe('lead-7');
      expect(event.schema_version).toBe('1.0');
      expect(event.correlation_id).toBe('corr-7');

      // Payload
      const p = event.payload as Record<string, unknown>;
      expect(p).toMatchObject({
        membership_id: 'mem-7',
        lead_id: 'lead-7',
        location_id: 'loc-7',
        pipeline: 'new_patient',
        archived_at: now,
      });
    });
  });
});
