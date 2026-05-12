import type { Knex } from 'knex';
import type { EventBus, OrthoEvent } from '@ortho/event-bus';
import { createEventBus } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import db, { destroy } from './db.js';
import { handleLeadCreated } from './handlers/lead-created.js';
import { handleLeadStageChanged } from './handlers/lead-stage-changed.js';
import { handleLeadConverted } from './handlers/lead-converted.js';

const log = createLogger('crm-referral-worker');

async function startConsumer(db: Knex, bus: EventBus): Promise<void> {
  bus.subscribe('lead.created', async (event: OrthoEvent) => {
    log.info({ lead_id: event.payload.lead_id }, 'Received lead.created event');
    await handleLeadCreated(event, db);
  });

  bus.subscribe('lead.stage_changed', async (event: OrthoEvent) => {
    log.info({ lead_id: event.payload.lead_id }, 'Received lead.stage_changed event');
    await handleLeadStageChanged(event, db);
  });

  bus.subscribe('lead.converted', async (event: OrthoEvent) => {
    log.info({ lead_id: event.payload.lead_id }, 'Received lead.converted event');
    await handleLeadConverted(event, db, bus);
  });

  await bus.start();
  log.info('SQS consumer started');
}

const bus = createEventBus();

startConsumer(db, bus).catch((err) => {
  log.error({ err }, 'Failed to start SQS consumer');
  process.exit(1);
});

log.info('Referral worker started');

process.on('SIGTERM', async () => {
  log.info('SIGTERM received, shutting down…');
  await bus.stop();
  await destroy();
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  log.error({ err }, 'Unhandled rejection in worker');
  process.exit(1);
});
