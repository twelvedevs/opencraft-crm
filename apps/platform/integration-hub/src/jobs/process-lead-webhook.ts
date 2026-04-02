import { Worker } from 'bullmq';
import type { Pool } from 'pg';
import type { EventBus } from '@ortho/event-bus';
import type { AdLeadReceivedPayload } from '@ortho/types';
import type { Logger } from 'pino';
import type { LeadEvent } from '../connectors/interface.js';
import * as mappingsRepo from '../repositories/mappings.js';
import { publishAdLeadReceived } from '../services/event-publisher.js';

interface ProcessLeadWebhookJobData {
  platform: string;
  leadEvent: LeadEvent;
}

export function createProcessLeadWebhookWorker(
  pool: Pool,
  bus: EventBus,
  redisConnection: { host: string; port: number },
  log: Logger,
): Worker<ProcessLeadWebhookJobData> {
  const worker = new Worker<ProcessLeadWebhookJobData>(
    'integration-hub:process-lead-webhook',
    async (job) => {
      const { platform, leadEvent } = job.data;
      const client = await pool.connect();
      try {
        // Look up location_id from campaign_location_mappings
        // We need to find the account for this platform+campaign, but we only have campaign_id
        // findByCampaignId requires accountId — instead query by campaign_id across all accounts for this platform
        let locationId: string | null = null;

        // Query campaign_location_mappings directly by campaign_id
        // Since we don't have an account_id, search across all mappings for this campaign
        const result = await client.query<{ location_id: string }>(
          `SELECT location_id FROM platform_integrations.campaign_location_mappings
           WHERE campaign_id = $1 LIMIT 1`,
          [leadEvent.campaign_id],
        );
        if (result.rows.length > 0) {
          locationId = result.rows[0].location_id;
        }

        const payload: AdLeadReceivedPayload = {
          platform,
          external_lead_id: leadEvent.external_lead_id,
          campaign_id: leadEvent.campaign_id,
          ad_set_id: leadEvent.ad_set_id,
          ad_id: leadEvent.ad_id,
          form_id: leadEvent.form_id,
          location_id: locationId,
          fields: leadEvent.fields,
        };

        await publishAdLeadReceived(bus, payload);

        log.info(
          { platform, external_lead_id: leadEvent.external_lead_id, location_id: locationId },
          'process-lead-webhook succeeded',
        );
      } catch (err) {
        log.error(
          { platform, external_lead_id: leadEvent.external_lead_id, err },
          'process-lead-webhook failed',
        );
        throw err;
      } finally {
        client.release();
      }
    },
    { connection: redisConnection },
  );

  return worker;
}
