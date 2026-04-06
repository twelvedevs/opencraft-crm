import type { Knex } from 'knex';
import { createEventBus, type EventBus, type OrthoEvent } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import { handleAdLeadReceived } from './handlers/ad-lead-received.js';
import { handleStageChanged } from './handlers/stage-changed.js';
import { handleLeadArchived } from './handlers/lead-archived.js';

const log = createLogger('crm-lead');

type Handler = (event: OrthoEvent, db: Knex, bus?: EventBus) => Promise<void>;

function wrapHandler(
  bus: EventBus,
  eventType: string,
  handler: Handler,
  db: Knex,
  passBus?: EventBus,
): void {
  bus.subscribe(eventType, async (event: OrthoEvent) => {
    try {
      await handler(event, db, passBus);
    } catch (err) {
      log.error({ err, event_id: event.event_id }, 'handler error');
    }
  });
}

export function createEventWorker(db: Knex): { start: () => Promise<void>; stop: () => Promise<void> } {
  const bus = createEventBus();

  // Stub handlers — real implementations added in US-004 through US-011
  const noop: Handler = async () => {};

  // 13 subscriptions in specified order
  // ad_lead.received is the only handler that receives bus as 3rd argument
  wrapHandler(bus, 'ad_lead.received', handleAdLeadReceived as Handler, db, bus);
  wrapHandler(bus, 'lead.stage_changed', handleStageChanged, db);
  wrapHandler(bus, 'lead.archived', handleLeadArchived, db);
  wrapHandler(bus, 'lead.converted', noop, db);
  wrapHandler(bus, 'opt_out.received', noop, db);
  wrapHandler(bus, 'opt_out.removed', noop, db);
  wrapHandler(bus, 'email.bounced', noop, db);
  wrapHandler(bus, 'message.delivered', noop, db);
  wrapHandler(bus, 'message.failed', noop, db);
  wrapHandler(bus, 'inbound_message.received', noop, db);
  wrapHandler(bus, 'referral.converted', noop, db);
  wrapHandler(bus, 'sequence.step_completed', noop, db);
  wrapHandler(bus, 'workflow.triggered', noop, db);

  return {
    start: () => bus.start(),
    stop: () => bus.stop(),
  };
}
