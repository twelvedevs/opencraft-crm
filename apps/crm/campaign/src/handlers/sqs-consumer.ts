import type { Knex } from 'knex';
import type { EventBus, OrthoEvent } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import { handleEmailCampaignCompleted } from './email-campaign-completed.handler.js';
import type { EmailCampaignCompletedPayload } from './email-campaign-completed.handler.js';
import { handleEmailOpened } from './email-opened.handler.js';
import type { EmailOpenedPayload } from './email-opened.handler.js';
import { handleLeadStageChanged } from './lead-stage-changed.handler.js';
import type { LeadStageChangedPayload } from './lead-stage-changed.handler.js';

const log = createLogger('campaign-sqs-consumer');

export async function startConsumer(db: Knex, bus: EventBus): Promise<void> {
  bus.subscribe('email.campaign_completed', async (event: OrthoEvent) => {
    const payload = event.payload as unknown as EmailCampaignCompletedPayload;
    log.info({ job_id: payload.job_id }, 'Received email.campaign_completed event');
    await handleEmailCampaignCompleted(payload, db, bus);
  });

  bus.subscribe('email.opened', async (event: OrthoEvent) => {
    const payload = event.payload as unknown as EmailOpenedPayload;
    log.info({ campaign_job_id: payload.campaign_job_id }, 'Received email.opened event');
    await handleEmailOpened(payload, db);
  });

  bus.subscribe('lead.stage_changed', async (event: OrthoEvent) => {
    const payload = event.payload as unknown as LeadStageChangedPayload;
    log.info({ lead_id: payload.lead_id }, 'Received lead.stage_changed event');
    await handleLeadStageChanged(payload, db);
  });

  await bus.start();
  log.info('SQS consumer started');
}
