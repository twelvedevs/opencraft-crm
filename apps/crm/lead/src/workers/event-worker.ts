import type { Knex } from 'knex';
import { createEventBus, type EventBus, type OrthoEvent } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import { handleAdLeadReceived } from './handlers/ad-lead-received.js';
import { handleStageChanged } from './handlers/stage-changed.js';
import { handleLeadArchived } from './handlers/lead-archived.js';
import { handleLeadConverted } from './handlers/lead-converted.js';
import { handleOptOutReceived } from './handlers/opt-out-received.js';
import { handleOptOutRemoved } from './handlers/opt-out-removed.js';
import { handleEmailBounced } from './handlers/email-bounced.js';
import { handleMessageDelivered } from './handlers/message-delivered.js';
import { handleMessageFailed } from './handlers/message-failed.js';
import { handleInboundMessageReceived } from './handlers/inbound-message-received.js';
import { handleReferralConverted } from './handlers/referral-converted.js';
import { handleSequenceStepCompleted } from './handlers/sequence-step-completed.js';
import { handleWorkflowTriggered } from './handlers/workflow-triggered.js';

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

  // 13 subscriptions in specified order
  // ad_lead.received is the only handler that receives bus as 3rd argument
  wrapHandler(bus, 'ad_lead.received', handleAdLeadReceived as Handler, db, bus);
  wrapHandler(bus, 'lead.stage_changed', handleStageChanged, db);
  wrapHandler(bus, 'lead.archived', handleLeadArchived, db);
  wrapHandler(bus, 'lead.converted', handleLeadConverted, db);
  wrapHandler(bus, 'opt_out.received', handleOptOutReceived, db);
  wrapHandler(bus, 'opt_out.removed', handleOptOutRemoved, db);
  wrapHandler(bus, 'email.bounced', handleEmailBounced, db);
  wrapHandler(bus, 'message.delivered', handleMessageDelivered, db);
  wrapHandler(bus, 'message.failed', handleMessageFailed, db);
  wrapHandler(bus, 'inbound_message.received', handleInboundMessageReceived, db);
  wrapHandler(bus, 'referral.converted', handleReferralConverted, db);
  wrapHandler(bus, 'sequence.step_completed', handleSequenceStepCompleted, db);
  wrapHandler(bus, 'workflow.triggered', handleWorkflowTriggered, db);

  return {
    start: () => bus.start(),
    stop: () => bus.stop(),
  };
}
