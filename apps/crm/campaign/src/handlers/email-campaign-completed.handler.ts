import type { Knex } from 'knex';
import type { EventBus } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import * as sendsRepo from '../repositories/campaign-sends.repo.js';
import * as campaignsRepo from '../repositories/campaigns.repo.js';
import { insertEvent } from '../repositories/campaign-events.repo.js';
import { countNonTerminalSends } from '../repositories/campaign-sends.repo.js';
import { publishCampaignSent } from '../events/publisher.js';

const log = createLogger('email-campaign-completed-handler');

export interface EmailCampaignCompletedPayload {
  job_id: string;
  status: string;
  sent_count: number;
  failed_count: number;
  total_recipients: number;
  completed_at: string;
}

export async function handleEmailCampaignCompleted(
  payload: EmailCampaignCompletedPayload,
  db: Knex,
  bus: EventBus,
): Promise<void> {
  const { job_id } = payload;

  // Step 1: look up campaign_sends by email_job_id
  const send = await sendsRepo.findByEmailJobId(db, job_id);
  if (!send) {
    log.warn({ job_id }, 'No campaign_sends row found for email job_id, skipping');
    return;
  }

  // Load campaign (needed for template_id and ab_phase)
  const campaign = await campaignsRepo.findById(db, send.campaign_id);
  if (!campaign) {
    log.warn({ campaign_id: send.campaign_id }, 'Campaign not found');
    return;
  }

  // Step 2: update campaign_sends row with payload data
  await sendsRepo.update(db, send.id, {
    status: payload.status,
    sent_count: payload.sent_count,
    failed_count: payload.failed_count,
    total_recipients: payload.total_recipients,
    completed_at: new Date(payload.completed_at),
  });

  // Step 3: publish campaign.sent event
  await publishCampaignSent(bus, {
    campaign_id: send.campaign_id,
    location_id: send.location_id,
    sent_count: payload.sent_count,
    template_id: campaign.template_id,
    completed_at: payload.completed_at,
  });

  // If A/B testing phase, don't determine terminal status yet
  if (campaign.ab_phase === 'testing') {
    return;
  }

  // Count non-terminal sends still in flight
  const inFlightCount = await countNonTerminalSends(db, send.campaign_id);
  if (inFlightCount > 0) {
    return;
  }

  // Step 5: determine terminal status
  const allSends = await sendsRepo.findAllByCampaignId(db, send.campaign_id);

  const hasAnyCompletion = allSends.some(
    (s) => s.status === 'completed' || s.status === 'completed_with_errors',
  );
  const hasAnyErrors = allSends.some(
    (s) =>
      s.status === 'failed' ||
      s.status === 'completed_with_errors' ||
      s.failed_count > 0,
  );
  const allFailed = allSends.every((s) => s.status === 'failed');

  let terminal: string;
  if (allFailed) {
    terminal = 'failed';
  } else if (hasAnyCompletion && hasAnyErrors) {
    terminal = 'completed_with_errors';
  } else {
    terminal = 'completed';
  }

  await campaignsRepo.update(db, campaign.id, {
    status: terminal,
    completed_at: new Date(),
  });

  await insertEvent(db, {
    campaign_id: campaign.id,
    from_status: 'sending',
    to_status: terminal,
    actor_id: null,
  });

  log.info(
    { campaign_id: campaign.id, terminal },
    'Campaign reached terminal status',
  );
}
