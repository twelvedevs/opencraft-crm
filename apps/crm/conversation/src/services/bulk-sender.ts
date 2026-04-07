import type { Knex } from 'knex';
import { createLogger } from '@ortho/logger';
import * as bulkSendJobsRepo from '../repositories/bulk-send-jobs.repo.js';
import * as settingsRepo from '../repositories/settings.repo.js';
import { leadClient, audienceClient, messagingClient } from '../lib/service-client.js';

const logger = createLogger('crm-conversation');

interface Lead {
  id: string;
  phone: string;
  current_stage: string;
  current_pipeline: string;
  created_at: string;
  tags: string[];
}

interface LeadListResponse {
  data: Lead[];
  next_cursor: string | null;
}

interface AudienceEvaluateResponse {
  matched_entity_ids: string[];
}

export async function executeBulkSend(
  db: Knex,
  jobId: string,
  opts: { locationId: string; segment: unknown; body: string },
): Promise<void> {
  const log = logger.child({ jobId });

  // Mark as processing
  await bulkSendJobsRepo.updateStatus(db, jobId, 'processing');

  try {
    // Load settings for practice_number
    const settings = await settingsRepo.getEffectiveSettings(db, opts.locationId);

    // Paginate through all leads for this location
    const leadMap = new Map<string, Lead>();
    let cursor: string | undefined;

    while (true) {
      const params: Record<string, string> = {
        location_id: opts.locationId,
        status: 'active',
        limit: '200',
      };
      if (cursor) params.cursor = cursor;

      const response = await leadClient.get<LeadListResponse>('/leads', params);
      for (const lead of response.data) {
        leadMap.set(lead.id, lead);
      }

      if (!response.next_cursor) break;
      cursor = response.next_cursor;
    }

    // Evaluate audience segment
    const entities = Array.from(leadMap.values()).map((l) => ({
      id: l.id,
      current_stage: l.current_stage,
      current_pipeline: l.current_pipeline,
      created_at: l.created_at,
      tags: l.tags,
      phone: l.phone,
    }));

    const audienceResult = await audienceClient.post<AudienceEvaluateResponse>(
      '/audiences/evaluate',
      { filter: opts.segment, entities, snapshot: false },
    );

    const matchedIds = audienceResult.matched_entity_ids;

    // Update total
    await bulkSendJobsRepo.updateStatus(db, jobId, 'processing', { total: matchedIds.length });

    // Send in batches of 50
    let sent = 0;
    let failed = 0;
    const BATCH_SIZE = 50;

    for (let i = 0; i < matchedIds.length; i += BATCH_SIZE) {
      const batch = matchedIds.slice(i, i + BATCH_SIZE);

      for (const leadId of batch) {
        const lead = leadMap.get(leadId);
        if (!lead) {
          log.warn({ leadId }, 'Lead not found in map, skipping');
          failed++;
          continue;
        }

        try {
          await messagingClient.post('/messages/send', {
            to: lead.phone,
            from_number: settings.practice_number,
            body: opts.body,
            dedup_key: `${jobId}:${leadId}`,
          });
          sent++;
        } catch (err) {
          log.error({ err, leadId }, 'Failed to send bulk message to lead');
          failed++;
        }
      }
    }

    // Mark completed
    await bulkSendJobsRepo.updateStatus(db, jobId, 'completed', {
      sent,
      failed,
      completed_at: new Date(),
    });

    log.info({ sent, failed, total: matchedIds.length }, 'Bulk send completed');
  } catch (err) {
    // Mark failed on uncaught error
    await bulkSendJobsRepo.updateStatus(db, jobId, 'failed');
    throw err;
  }
}
