import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Knex } from 'knex';
import {
  EventBusImpl,
  MockDriver,
  type OrthoEvent,
  type EventHandler,
  type Driver,
} from '@ortho/event-bus';
import {
  HAS_DB,
  runMigrations,
  cleanup,
  truncateTables,
  getDb,
  LOCATION_ID,
} from './helpers.js';

import { handleAdLeadReceived } from '../../src/workers/handlers/ad-lead-received.js';
import { handleStageChanged } from '../../src/workers/handlers/stage-changed.js';
import { handleLeadArchived } from '../../src/workers/handlers/lead-archived.js';
import { handleLeadConverted } from '../../src/workers/handlers/lead-converted.js';
import { handleOptOutReceived } from '../../src/workers/handlers/opt-out-received.js';
import { handleOptOutRemoved } from '../../src/workers/handlers/opt-out-removed.js';
import { handleEmailBounced } from '../../src/workers/handlers/email-bounced.js';
import { handleMessageDelivered } from '../../src/workers/handlers/message-delivered.js';
import { handleMessageFailed } from '../../src/workers/handlers/message-failed.js';
import { handleInboundMessageReceived } from '../../src/workers/handlers/inbound-message-received.js';
import { handleReferralConverted } from '../../src/workers/handlers/referral-converted.js';
import { handleSequenceStepCompleted } from '../../src/workers/handlers/sequence-step-completed.js';
import { handleWorkflowTriggered } from '../../src/workers/handlers/workflow-triggered.js';

// ---------------------------------------------------------------------------
// DispatchDriver — in-memory driver that dispatches events to handlers
// synchronously on publish, so tests don't need real Redis.
// ---------------------------------------------------------------------------
class DispatchDriver implements Driver {
  readonly published: OrthoEvent[] = [];
  private subscriptions = new Map<string, EventHandler[]>();

  async publish(event: OrthoEvent): Promise<void> {
    this.published.push(event);
    const handlers = this.subscriptions.get(event.event_type) ?? [];
    for (const handler of handlers) {
      await handler(event);
    }
  }

  async start(subscriptions: Map<string, EventHandler[]>): Promise<void> {
    this.subscriptions = subscriptions;
  }

  async stop(): Promise<void> {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Handler = (event: OrthoEvent, db: Knex, bus?: any) => Promise<void>;

function buildTestWorker(db: Knex) {
  const dispatchDriver = new DispatchDriver();
  // Separate publish-only bus captured by ad_lead.received handler for publishing lead.created
  const publishDriver = new MockDriver();
  const publishBus = new EventBusImpl(publishDriver);

  const bus = new EventBusImpl(dispatchDriver);

  function wrap(eventType: string, handler: Handler, passBus?: any): void {
    bus.subscribe(eventType, async (event: OrthoEvent) => {
      await handler(event, db, passBus);
    });
  }

  // Wire all 13 handlers in the same order as event-worker.ts
  wrap('ad_lead.received', handleAdLeadReceived as Handler, publishBus);
  wrap('lead.stage_changed', handleStageChanged);
  wrap('lead.archived', handleLeadArchived);
  wrap('lead.converted', handleLeadConverted);
  wrap('opt_out.received', handleOptOutReceived);
  wrap('opt_out.removed', handleOptOutRemoved);
  wrap('email.bounced', handleEmailBounced);
  wrap('message.delivered', handleMessageDelivered);
  wrap('message.failed', handleMessageFailed);
  wrap('inbound_message.received', handleInboundMessageReceived);
  wrap('referral.converted', handleReferralConverted);
  wrap('sequence.step_completed', handleSequenceStepCompleted);
  wrap('workflow.triggered', handleWorkflowTriggered);

  return {
    bus,
    dispatchDriver,
    publishDriver,
    start: () => bus.start(),
    stop: () => bus.stop(),
  };
}

async function insertLead(
  db: Knex,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<Record<string, unknown>> {
  const defaults = {
    location_id: LOCATION_ID,
    first_name: 'Test',
    last_name: 'Lead',
    phone: '+12125551234',
    email: 'test@example.com',
    channel: 'website_form',
    contact_status: 'active',
    current_pipeline: 'new_patient',
    current_stage: 'new_lead',
    score: 0,
    duplicate_status: 'none',
    duplicate_of_id: null,
    merged_into_id: null,
    archived_at: null,
    treatment_interest: null,
    date_of_birth: null,
    last_activity_at: null,
    first_touch_source: null,
    first_touch_medium: null,
    first_touch_campaign: null,
    first_touch_ad: null,
    first_touch_keyword: null,
    first_touch_landing_page: null,
    first_touch_referring_url: null,
    first_touch_device: null,
    call_tracking_number: null,
    referrer_id: null,
    referrer_type: null,
    referral_code: null,
    ad_platform_lead_id: null,
    created_by_location: null,
  };

  const rows = await db('crm_leads.leads')
    .insert({ ...defaults, ...overrides })
    .returning('*');
  return rows[0] as Record<string, unknown>;
}

function makeEvent(
  eventType: string,
  payload: Record<string, unknown>,
  eventId?: string,
): OrthoEvent {
  return {
    event_id: eventId ?? `test:${eventType}:${Date.now()}`,
    event_type: eventType,
    entity_type: 'lead',
    entity_id: String(payload.lead_id ?? payload.entity_id ?? ''),
    payload,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)('event-worker integration', () => {
  let db: Knex;
  let worker: ReturnType<typeof buildTestWorker>;

  beforeAll(async () => {
    await runMigrations();
    db = getDb();
    worker = buildTestWorker(db);
    await worker.start();
  });

  afterAll(async () => {
    await worker.stop();
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
    worker.dispatchDriver.published.length = 0;
    worker.publishDriver.published.length = 0;
  });

  // ─── ad_lead.received ────────────────────────────────────────

  describe('ad_lead.received', () => {
    it('creates a lead with correct channel and inserts activity', async () => {
      await worker.bus.publish(
        makeEvent('ad_lead.received', {
          external_lead_id: 'gads-001',
          location_id: LOCATION_ID,
          platform: 'Google Ads',
          fields: {
            full_name: 'Jane Smith',
            phone_number: '2125559876',
            email: 'jane@example.com',
          },
        }),
      );

      // Lead created
      const leads = await db('crm_leads.leads').where({
        ad_platform_lead_id: 'gads-001',
      });
      expect(leads).toHaveLength(1);
      expect(leads[0].channel).toBe('google_ads');
      expect(leads[0].first_name).toBe('Jane');
      expect(leads[0].last_name).toBe('Smith');
      expect(leads[0].phone).toBe('+12125559876');

      // Activity inserted
      const activities = await db('crm_leads.lead_activities').where({
        lead_id: leads[0].id,
        event_type: 'lead.created',
      });
      expect(activities).toHaveLength(1);

      // last_activity_at set
      const lead = await db('crm_leads.leads').where({ id: leads[0].id }).first();
      expect(lead.last_activity_at).not.toBeNull();

      // lead.created event published
      const createdEvents = worker.publishDriver.published.filter(
        (e) => e.event_type === 'lead.created',
      );
      expect(createdEvents).toHaveLength(1);
    });

    it('is idempotent — publishing again with same external_lead_id creates no duplicate', async () => {
      const event = makeEvent('ad_lead.received', {
        external_lead_id: 'gads-002',
        location_id: LOCATION_ID,
        platform: 'Google Ads',
        fields: {
          full_name: 'Bob Test',
          phone_number: '2125551111',
          email: 'bob@example.com',
        },
      });

      await worker.bus.publish(event);
      await worker.bus.publish(event);

      const leads = await db('crm_leads.leads').where({
        ad_platform_lead_id: 'gads-002',
      });
      expect(leads).toHaveLength(1);
    });
  });

  // ─── lead.stage_changed ──────────────────────────────────────

  describe('lead.stage_changed', () => {
    it('updates pipeline/stage cache and recalculates score', async () => {
      const lead = await insertLead(db);

      await worker.bus.publish(
        makeEvent('lead.stage_changed', {
          lead_id: lead.id,
          pipeline: 'new_patient',
          stage_to: 'contacted',
          stage_from: 'new_lead',
          reason: 'agent_action',
          time_in_stage_seconds: 3600,
        }),
      );

      const updated = await db('crm_leads.leads').where({ id: lead.id }).first();
      expect(updated.current_pipeline).toBe('new_patient');
      expect(updated.current_stage).toBe('contacted');
      expect(updated.score).toBeGreaterThan(0);

      // Timeline entry inserted
      const activities = await db('crm_leads.lead_activities').where({
        lead_id: lead.id as string,
        event_type: 'lead.stage_changed',
      });
      expect(activities).toHaveLength(1);
    });
  });

  // ─── lead.archived ───────────────────────────────────────────

  describe('lead.archived', () => {
    it('clears pipeline/stage and inserts idempotent timeline entry', async () => {
      const lead = await insertLead(db, {
        current_pipeline: 'new_patient',
        current_stage: 'contacted',
      });

      await worker.bus.publish(
        makeEvent('lead.archived', { lead_id: lead.id }),
      );

      const updated = await db('crm_leads.leads').where({ id: lead.id }).first();
      expect(updated.current_pipeline).toBeNull();
      expect(updated.current_stage).toBeNull();

      const activities = await db('crm_leads.lead_activities').where({
        source_event_id: `internal:lead.archived:${lead.id}`,
      });
      expect(activities).toHaveLength(1);
    });

    it('does not create duplicate timeline entry on re-publish (ON CONFLICT idempotency)', async () => {
      const lead = await insertLead(db);

      await worker.bus.publish(
        makeEvent('lead.archived', { lead_id: lead.id }),
      );
      await worker.bus.publish(
        makeEvent('lead.archived', { lead_id: lead.id }),
      );

      const activities = await db('crm_leads.lead_activities').where({
        source_event_id: `internal:lead.archived:${lead.id}`,
      });
      expect(activities).toHaveLength(1);
    });

    it('respects pre-existing HTTP archive timeline entry (cross-path idempotency)', async () => {
      const lead = await insertLead(db);

      // Simulate the HTTP archive route having already written the timeline entry
      await db('crm_leads.lead_activities').insert({
        lead_id: lead.id,
        event_type: 'lead.archived',
        actor_type: 'system',
        actor_id: null,
        payload: JSON.stringify({}),
        occurred_at: new Date().toISOString(),
        source_event_id: `internal:lead.archived:${lead.id}`,
      });

      // Worker processes the same event — should not duplicate
      await worker.bus.publish(
        makeEvent('lead.archived', { lead_id: lead.id }),
      );

      const activities = await db('crm_leads.lead_activities').where({
        source_event_id: `internal:lead.archived:${lead.id}`,
      });
      expect(activities).toHaveLength(1);
    });
  });

  // ─── opt_out.received ────────────────────────────────────────

  describe('opt_out.received', () => {
    it('sets contact_status to sms_opted_out and inserts timeline entry', async () => {
      const lead = await insertLead(db, {
        phone: '+12125552222',
        contact_status: 'active',
      });

      await worker.bus.publish(
        makeEvent('opt_out.received', {
          phone_number: '+12125552222',
          opted_out_at: new Date().toISOString(),
          source: 'twilio',
        }),
      );

      const updated = await db('crm_leads.leads').where({ id: lead.id }).first();
      expect(updated.contact_status).toBe('sms_opted_out');

      const activities = await db('crm_leads.lead_activities').where({
        lead_id: lead.id as string,
        event_type: 'opt_out.received',
      });
      expect(activities).toHaveLength(1);

      expect(updated.last_activity_at).not.toBeNull();
    });
  });

  // ─── email.bounced (soft) ────────────────────────────────────

  describe('email.bounced soft bounce', () => {
    it('does not change contact_status or insert timeline entry for soft bounces', async () => {
      const lead = await insertLead(db, { email: 'soft@example.com' });

      await worker.bus.publish(
        makeEvent('email.bounced', {
          to_address: 'soft@example.com',
          bounce_type: 'soft',
        }),
      );

      const updated = await db('crm_leads.leads').where({ id: lead.id }).first();
      expect(updated.contact_status).toBe('active');

      const activities = await db('crm_leads.lead_activities').where({
        lead_id: lead.id as string,
        event_type: 'email.bounced',
      });
      expect(activities).toHaveLength(0);
    });
  });

  // ─── email.bounced (hard) ────────────────────────────────────

  describe('email.bounced hard bounce', () => {
    it('sets contact_status to email_invalid and inserts timeline entry', async () => {
      const lead = await insertLead(db, { email: 'hard@example.com' });

      await worker.bus.publish(
        makeEvent('email.bounced', {
          to_address: 'hard@example.com',
          bounce_type: 'hard',
        }),
      );

      const updated = await db('crm_leads.leads').where({ id: lead.id }).first();
      expect(updated.contact_status).toBe('email_invalid');

      const activities = await db('crm_leads.lead_activities').where({
        lead_id: lead.id as string,
        event_type: 'email.bounced',
      });
      expect(activities).toHaveLength(1);
    });
  });

  // ─── inbound_message.received ────────────────────────────────

  describe('inbound_message.received', () => {
    it('recalculates score and inserts timeline entry', async () => {
      const lead = await insertLead(db, { phone: '+12125553333' });

      await worker.bus.publish(
        makeEvent('inbound_message.received', {
          message_id: 'msg-001',
          from_number: '+12125553333',
          to_number: '+18005551234',
          body: 'Hi there',
          media_urls: null,
          received_at: new Date().toISOString(),
          message_type: 'sms',
        }),
      );

      const updated = await db('crm_leads.leads').where({ id: lead.id }).first();
      expect(updated.score).toBeGreaterThan(0);

      const activities = await db('crm_leads.lead_activities').where({
        lead_id: lead.id as string,
        event_type: 'inbound_message.received',
      });
      expect(activities).toHaveLength(1);
    });
  });

  // ─── workflow.triggered (non-lead entity_type) ───────────────

  describe('workflow.triggered with entity_type !== lead', () => {
    it('does not create any lead_activities rows', async () => {
      // Insert a lead just so we can verify nothing was written for it
      await insertLead(db);

      await worker.bus.publish(
        makeEvent('workflow.triggered', {
          entity_id: 'some-contact-id',
          entity_type: 'contact',
          workflow_id: 'wf-001',
        }),
      );

      const activities = await db('crm_leads.lead_activities');
      expect(activities).toHaveLength(0);
    });
  });
});
