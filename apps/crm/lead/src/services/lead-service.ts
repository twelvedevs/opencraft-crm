import type { Knex } from 'knex';
import type { EventBus } from '@ortho/event-bus';
import { parsePhoneNumber } from 'libphonenumber-js';
import { createLogger } from '@ortho/logger';
import * as leadRepository from '../repositories/lead-repository.js';
import * as activityRepository from '../repositories/activity-repository.js';
import type { Lead, CreateLeadData, ListLeadsParams } from '../repositories/lead-repository.js';
import {
  publishLeadCreated,
  publishLeadUpdated,
  publishLeadArchived,
} from '../events/publisher.js';

const log = createLogger('crm-lead');

export type { Lead };

export type CreateLeadInput = Omit<
  CreateLeadData,
  'score' | 'current_pipeline' | 'contact_status' | 'duplicate_status'
>;

// Only user-mutable fields are exposed — internal fields (score, current_pipeline,
// pipeline/stage cache, merge/archive state, attribution) must not be set via this type.
export type UpdateLeadInput = Partial<{
  first_name: string;
  last_name: string;
  phone: string;
  email: string | null;
  treatment_interest: string | null;
  date_of_birth: string | null;
  location_id: string;
}>;

const ATTRIBUTION_FIELDS = [
  'first_touch_source',
  'first_touch_medium',
  'first_touch_campaign',
  'first_touch_ad',
  'first_touch_keyword',
  'first_touch_landing_page',
  'first_touch_referring_url',
  'first_touch_device',
  'call_tracking_number',
  'referrer_id',
  'referrer_type',
  'referral_code',
  'ad_platform_lead_id',
  'created_by_location',
  'channel',
] as const;

export function normalizePhone(phone: string): string {
  const parsed = parsePhoneNumber(phone, 'US');
  if (!parsed || !parsed.isValid()) {
    throw new Error('invalid phone number');
  }
  return parsed.format('E.164');
}

export async function createLead(
  db: Knex,
  data: CreateLeadInput,
  eventBus: EventBus,
  createdBy: string,
): Promise<Lead> {
  const phone = normalizePhone(data.phone);

  // Step 1 — ad_platform_lead_id idempotency
  if (data.ad_platform_lead_id) {
    const existing = await leadRepository.findByAdPlatformLeadId(db, data.ad_platform_lead_id);
    if (existing) {
      return existing;
    }
  }

  // Step 2 — phone dedup
  const phoneMatches = await leadRepository.findByPhone(db, phone);

  // Step 3 — email dedup
  const emailMatches = data.email
    ? await leadRepository.findByEmail(db, data.email)
    : [];

  // Step 4 — determine duplicate_status
  const allMatches = [...phoneMatches, ...emailMatches];
  const duplicate_status = allMatches.length > 0 ? 'flagged' : 'none';

  // Step 5 — determine duplicate_of_id (oldest match by created_at)
  let duplicate_of_id: string | null = null;
  if (allMatches.length > 0) {
    // Deduplicate by id in case same lead matched on both phone and email
    const uniqueMatches = new Map(allMatches.map((l) => [l.id, l]));
    const oldest = [...uniqueMatches.values()].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    )[0];
    duplicate_of_id = oldest.id;
  }

  // Steps 6-7 — insert lead + activity atomically
  const lead = await db.transaction(async (trx) => {
    const created = await leadRepository.createLead(trx, {
      ...data,
      phone,
      score: 0,
      current_pipeline: 'none',
      contact_status: 'active',
      duplicate_status,
      duplicate_of_id,
    });

    await activityRepository.insertActivity(trx, {
      lead_id: created.id,
      event_type: 'lead.created',
      actor_type: 'staff',
      actor_id: createdBy,
      payload: created as unknown as Record<string, unknown>,
      occurred_at: created.created_at,
      source_event_id: `internal:lead.created:${created.id}`,
    });

    return created;
  });

  // Publish event
  await publishLeadCreated(eventBus, {
    lead_id: lead.id,
    location_id: lead.location_id,
    channel: lead.channel,
    current_pipeline: lead.current_pipeline,
    current_stage: lead.current_stage,
    referrer_id: lead.referrer_id ?? undefined,
    referrer_type: lead.referrer_type ?? undefined,
    referral_code: lead.referral_code ?? undefined,
  });

  return lead;
}

export async function getLead(db: Knex, id: string): Promise<Lead | null> {
  return leadRepository.findById(db, id);
}

export async function updateLead(
  db: Knex,
  id: string,
  fields: UpdateLeadInput,
  eventBus: EventBus,
): Promise<Lead> {
  // Reject attribution fields
  for (const key of ATTRIBUTION_FIELDS) {
    if (key in fields) {
      throw new Error('attribution fields are immutable');
    }
  }

  // Normalize phone if present
  if (fields.phone !== undefined) {
    fields.phone = normalizePhone(fields.phone);
  }

  // Update lead + insert activity atomically
  const lead = await db.transaction(async (trx) => {
    const updated = await leadRepository.updateLead(trx, id, fields);
    if (!updated) {
      throw new Error('lead not found');
    }

    const changed_fields = Object.keys(fields);

    await activityRepository.insertActivity(trx, {
      lead_id: updated.id,
      event_type: 'lead.updated',
      actor_type: 'staff',
      actor_id: null,
      payload: { changed_fields },
      occurred_at: updated.updated_at,
      source_event_id: `internal:lead.updated:${updated.id}:${updated.updated_at}`,
    });

    return updated;
  });

  const changed_fields = Object.keys(fields);

  // Publish event
  await publishLeadUpdated(eventBus, {
    lead_id: lead.id,
    location_id: lead.location_id,
    changed_fields,
  });

  return lead;
}

export async function archiveLead(db: Knex, id: string, eventBus: EventBus): Promise<Lead> {
  // Archive lead + insert activity atomically
  const lead = await db.transaction(async (trx) => {
    const archived = await leadRepository.archiveLead(trx, id);

    await activityRepository.insertActivity(trx, {
      lead_id: archived.id,
      event_type: 'lead.archived',
      actor_type: 'staff',
      actor_id: null,
      payload: {},
      occurred_at: archived.updated_at,
      source_event_id: `internal:lead.archived:${archived.id}`,
    });

    return archived;
  });

  // Publish event
  await publishLeadArchived(eventBus, {
    lead_id: lead.id,
    location_id: lead.location_id,
  });

  return lead;
}

export async function listLeads(
  db: Knex,
  params: Omit<ListLeadsParams, 'locationIds'>,
  userLocations: string[],
): Promise<{ leads: Lead[]; nextCursor: string | null }> {
  return leadRepository.listLeads(db, {
    ...params,
    locationIds: userLocations,
  });
}
