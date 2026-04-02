import type { Pool } from 'pg';
import type { OrthoEvent } from '@ortho/event-bus';
import { handleLeadCreated } from '../handlers/lead-created.js';
import { handleStageChanged } from '../handlers/stage-changed.js';
import { handleLeadArchived } from '../handlers/lead-archived.js';
import { handleLeadConverted } from '../handlers/lead-converted.js';
import { handleMessageDelivered } from '../handlers/message-delivered.js';
import { handleMessageFailed } from '../handlers/message-failed.js';
import { handleOptOutReceived } from '../handlers/opt-out-received.js';
import { handleCampaignSent } from '../handlers/campaign-sent.js';
import { handleCampaignDelivered } from '../handlers/campaign-delivered.js';
import { handleEmailOpened } from '../handlers/email-opened.js';
import { handleEmailClicked } from '../handlers/email-clicked.js';
import { handleReferralConverted } from '../handlers/referral-converted.js';
import { handleAdSpendSynced } from '../handlers/ad-spend-synced.js';

export async function routeEvent(event: OrthoEvent, pool: Pool): Promise<void> {
  switch (event.event_type) {
    case 'lead.created':
      return handleLeadCreated(event, pool);
    case 'lead.stage_changed':
      return handleStageChanged(event, pool);
    case 'lead.archived':
      return handleLeadArchived(event, pool);
    case 'lead.converted':
      return handleLeadConverted(event, pool);
    case 'message.delivered':
      return handleMessageDelivered(event, pool);
    case 'message.failed':
      return handleMessageFailed(event, pool);
    case 'opt_out.received':
      return handleOptOutReceived(event, pool);
    case 'campaign.sent':
      return handleCampaignSent(event, pool);
    case 'campaign.delivered':
      return handleCampaignDelivered(event, pool);
    case 'email.opened':
      return handleEmailOpened(event, pool);
    case 'email.clicked':
      return handleEmailClicked(event, pool);
    case 'referral.converted':
      return handleReferralConverted(event, pool);
    case 'ad_spend.synced':
      return handleAdSpendSynced(event, pool);
    default:
      // Unknown event types are silently ignored — no retry, no throw
      console.debug(`[analytics] unknown event_type: ${event.event_type}`);
  }
}
