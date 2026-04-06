import type { Knex } from 'knex';
import type { EventBus } from '@ortho/event-bus';
import { env } from '../env.js';
import * as leadRepository from '../repositories/lead-repository.js';
import * as activityRepository from '../repositories/activity-repository.js';
import type { Lead } from '../repositories/lead-repository.js';
import { publishLeadMerged } from '../events/publisher.js';

export class MergeError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'MergeError';
  }
}

export async function mergeLeads(
  db: Knex,
  eventBus: EventBus,
  survivingLeadId: string,
  mergeLeadId: string,
  winningStage: string,
  mergedBy: string,
  userLocations: string[],
): Promise<Lead> {
  // Step 1 — validate
  const survivingLead = await leadRepository.findById(db, survivingLeadId);
  if (!survivingLead) {
    throw new MergeError('lead not found', 404);
  }

  const mergeLead = await leadRepository.findById(db, mergeLeadId);
  if (!mergeLead) {
    throw new MergeError('lead not found', 404);
  }

  if (survivingLead.merged_into_id) {
    throw new MergeError('lead already merged', 400);
  }
  if (mergeLead.merged_into_id) {
    throw new MergeError('lead already merged', 400);
  }

  // Location access check (empty userLocations = super_admin bypass)
  if (userLocations.length > 0) {
    if (
      !userLocations.includes(survivingLead.location_id) ||
      !userLocations.includes(mergeLead.location_id)
    ) {
      throw new MergeError('access denied', 403);
    }
  }

  // Step 2 — Pipeline Engine call (before any DB writes)
  if (winningStage !== survivingLead.current_stage) {
    const url =
      env.PIPELINE_ENGINE_URL +
      '/pipeline/leads/' +
      survivingLeadId +
      '/transition';

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.SERVICE_AUTH_TOKEN}`,
        },
        body: JSON.stringify({ stage: winningStage, reason: 'merge' }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new MergeError('pipeline engine unreachable or rejected transition', 503);
    }

    if (!response.ok) {
      throw new MergeError('pipeline engine unreachable or rejected transition', 503);
    }
  }

  // Steps 3–7 in a single transaction
  await db.transaction(async (trx) => {
    // Step 3 — copy activities from merged lead to surviving lead
    await trx.raw(
      `INSERT INTO crm_leads.lead_activities (id, lead_id, event_type, actor_type, actor_id, payload, occurred_at, source_event_id)
       SELECT gen_random_uuid(), ?, event_type, actor_type, actor_id, payload, occurred_at, source_event_id
       FROM crm_leads.lead_activities WHERE lead_id = ?
       ON CONFLICT (source_event_id) DO NOTHING`,
      [survivingLeadId, mergeLeadId],
    );

    // Step 4 — copy tags from merged lead not already on surviving lead
    await trx.raw(
      `INSERT INTO crm_leads.lead_tags (lead_id, tag_id, applied_by, applied_at)
       SELECT ?, tag_id, applied_by, applied_at
       FROM crm_leads.lead_tags WHERE lead_id = ?
       ON CONFLICT DO NOTHING`,
      [survivingLeadId, mergeLeadId],
    );

    // Step 5 — update merged lead
    await trx('crm_leads.leads')
      .where({ id: mergeLeadId })
      .update({
        merged_into_id: survivingLeadId,
        archived_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });

    // Step 6 — insert lead_merges row
    await trx('crm_leads.lead_merges').insert({
      surviving_lead_id: survivingLeadId,
      merged_lead_id: mergeLeadId,
      merged_lead_location_id: mergeLead.location_id,
      merged_by: mergedBy,
      merged_at: trx.fn.now(),
      stage_chosen: winningStage,
    });

    // Step 7 — insert activity for surviving lead
    await activityRepository.insertActivity(trx, {
      lead_id: survivingLeadId,
      event_type: 'lead.merged',
      actor_type: 'staff',
      actor_id: mergedBy,
      payload: { merged_lead_id: mergeLeadId },
      occurred_at: new Date().toISOString(),
      source_event_id: `internal:lead.merged:${survivingLeadId}:${mergeLeadId}`,
    });
  });

  // After transaction — publish event
  await publishLeadMerged(eventBus, {
    surviving_lead_id: survivingLeadId,
    merged_lead_id: mergeLeadId,
    location_id: survivingLead.location_id,
  });

  // Return surviving lead (re-fetched)
  const result = await leadRepository.findById(db, survivingLeadId);
  return result!;
}
