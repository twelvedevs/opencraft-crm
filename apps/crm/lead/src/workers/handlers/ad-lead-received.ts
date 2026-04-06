import type { Knex } from 'knex';
import type { EventBus, OrthoEvent } from '@ortho/event-bus';
import { createLogger } from '@ortho/logger';
import { normalizePhone } from '../../services/lead-service.js';
import * as leadRepository from '../../repositories/lead-repository.js';
import * as activityRepository from '../../repositories/activity-repository.js';
import { publishLeadCreated } from '../../events/publisher.js';

const log = createLogger('crm-lead');

export async function handleAdLeadReceived(
  event: OrthoEvent,
  db: Knex,
  bus: EventBus,
): Promise<void> {
  const payload = event.payload;

  // Parse payload fields
  const ad_platform_lead_id = String(payload.external_lead_id ?? '');
  const location_id = String(payload.location_id ?? '');
  const platform = String(payload.platform ?? '');
  const fields = payload.fields as Record<string, unknown> | undefined;
  const full_name = String(fields?.full_name ?? '');
  const phone_raw = String(fields?.phone_number ?? '');
  const email = String(fields?.email ?? '') || undefined;

  // Channel mapping
  let channel: string;
  const platformLower = platform.toLowerCase();
  if (platformLower.includes('google')) {
    channel = 'google_ads';
  } else if (platformLower.includes('facebook') || platformLower.includes('meta')) {
    channel = 'facebook_ads';
  } else {
    log.warn({ platform }, 'ad_lead.received: unrecognized platform, defaulting to google_ads');
    channel = 'google_ads';
  }

  // Name parsing
  const spaceIdx = full_name.indexOf(' ');
  const first_name = spaceIdx >= 0 ? full_name.slice(0, spaceIdx) : full_name;
  const last_name = spaceIdx >= 0 ? full_name.slice(spaceIdx + 1) : '';

  // Idempotency check
  const existing = await leadRepository.findByAdPlatformLeadId(db, ad_platform_lead_id);
  if (existing) {
    log.debug({ ad_platform_lead_id }, 'ad lead already exists, skipping');
    return;
  }

  // Phone normalization
  let phone: string;
  try {
    phone = normalizePhone(phone_raw);
  } catch {
    log.warn({ phone_raw }, 'ad_lead.received: invalid phone, skipping');
    return;
  }

  // Dedup check (same logic as lead-service.ts createLead)
  const phoneMatches = await leadRepository.findByPhone(db, phone);
  const emailMatches = email
    ? await leadRepository.findByEmail(db, email)
    : [];
  const allMatches = [...phoneMatches, ...emailMatches];
  const duplicate_status = allMatches.length > 0 ? 'flagged' : 'none';

  let duplicate_of_id: string | null = null;
  if (allMatches.length > 0) {
    const uniqueMatches = new Map(allMatches.map((l) => [l.id, l]));
    const oldest = [...uniqueMatches.values()].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    )[0];
    duplicate_of_id = oldest.id;
  }

  // DB transaction: insert lead + activity
  const newLead = await db.transaction(async (trx) => {
    const lead = await leadRepository.createLead(trx, {
      first_name,
      last_name,
      phone,
      email: email ?? null,
      channel,
      location_id,
      ad_platform_lead_id,
      contact_status: 'active',
      current_pipeline: 'none',
      current_stage: null,
      score: 0,
      duplicate_status,
      duplicate_of_id,
      treatment_interest: null,
      date_of_birth: null,
      last_activity_at: null,
      merged_into_id: null,
      archived_at: null,
      first_touch_source: null,
      first_touch_medium: null,
      first_touch_campaign: null,
      first_touch_ad: null,
      first_touch_keyword: null,
      first_touch_landing_page: null,
      first_touch_referring_url: null,
      first_touch_device: null,
      call_tracking_number: null,
      referrer_id: null,
      referrer_type: null,
      referral_code: null,
      created_by_location: null,
    });

    await activityRepository.insertActivity(trx, {
      lead_id: lead.id,
      event_type: 'lead.created',
      actor_type: 'system',
      actor_id: null,
      payload: { channel, location_id },
      occurred_at: new Date().toISOString(),
      source_event_id: event.event_id ?? `internal:lead.created:${lead.id}`,
    });

    return lead;
  });

  // Publish lead.created event
  await publishLeadCreated(bus, {
    lead_id: newLead.id,
    location_id,
    channel,
    current_pipeline: 'none',
    current_stage: null,
  });
}
