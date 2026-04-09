import type { Knex } from 'knex';
import { createLogger } from '@ortho/logger';
import * as sendsRepo from '../repositories/campaign-sends.repo.js';
import * as campaignsRepo from '../repositories/campaigns.repo.js';

const log = createLogger('email-opened-handler');

export interface EmailOpenedPayload {
  campaign_job_id: string;
  entity_type: string;
  entity_id: string;
}

export async function handleEmailOpened(
  payload: EmailOpenedPayload,
  db: Knex,
): Promise<void> {
  // Step 1: look up campaign_sends by email_job_id
  const send = await sendsRepo.findByEmailJobId(db, payload.campaign_job_id);
  if (!send) {
    return; // Not a Campaign Service job — ACK
  }

  // Step 2: load campaign; guard on status + ab_phase
  const campaign = await campaignsRepo.findById(db, send.campaign_id);
  if (!campaign) {
    return;
  }
  if (campaign.status !== 'sending' || campaign.ab_phase !== 'testing') {
    return; // Late opens or non-A/B — no-op
  }

  // Step 3: increment ab_opens for the matching variant
  if (send.variant === 'A') {
    await campaignsRepo.update(db, campaign.id, {
      ab_opens_a: campaign.ab_opens_a + 1,
    });
    log.info({ campaign_id: campaign.id, variant: 'A' }, 'Incremented ab_opens_a');
  } else if (send.variant === 'B') {
    await campaignsRepo.update(db, campaign.id, {
      ab_opens_b: campaign.ab_opens_b + 1,
    });
    log.info({ campaign_id: campaign.id, variant: 'B' }, 'Incremented ab_opens_b');
  }
  // variant='holdout' or null → no-op
}
