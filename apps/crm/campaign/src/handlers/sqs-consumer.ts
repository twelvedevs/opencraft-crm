import type { Knex } from 'knex';
import type { EventBus, OrthoEvent } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import { handleEmailCampaignCompleted } from './email-campaign-completed.handler.js';
import type { EmailCampaignCompletedPayload } from './email-campaign-completed.handler.js';

const log = createLogger('campaign-sqs-consumer');

export async function startConsumer(db: Knex, bus: EventBus): Promise<void> {
  bus.subscribe('email.campaign_completed', async (event: OrthoEvent) => {
    const payload = event.payload as unknown as EmailCampaignCompletedPayload;
    log.info({ job_id: payload.job_id }, 'Received email.campaign_completed event');
    await handleEmailCampaignCompleted(payload, db, bus);
  });

  await bus.start();
  log.info('SQS consumer started');
}
