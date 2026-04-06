import type { Knex } from 'knex';
import { parsePhoneNumber } from 'libphonenumber-js';
import * as leadRepository from '../repositories/lead-repository.js';
import type { Lead, CreateLeadData, ListLeadsParams } from '../repositories/lead-repository.js';

export type { Lead };

export type CreateLeadInput = Omit<
  CreateLeadData,
  'score' | 'current_pipeline' | 'contact_status' | 'duplicate_status'
>;

export type UpdateLeadInput = Partial<{
  first_name: string;
  last_name: string;
  phone: string;
  email: string | null;
  treatment_interest: string | null;
  date_of_birth: string | null;
  location_id: string;
  contact_status: string;
  current_pipeline: string;
  current_stage: string | null;
  last_activity_at: string | null;
  score: number;
  duplicate_status: string;
  duplicate_of_id: string | null;
  merged_into_id: string | null;
  archived_at: string | null;
  // Attribution fields (immutable — will be rejected)
  first_touch_source: string | null;
  first_touch_medium: string | null;
  first_touch_campaign: string | null;
  first_touch_ad: string | null;
  first_touch_keyword: string | null;
  first_touch_landing_page: string | null;
  first_touch_referring_url: string | null;
  first_touch_device: string | null;
  call_tracking_number: string | null;
  referrer_id: string | null;
  referrer_type: string | null;
  referral_code: string | null;
  ad_platform_lead_id: string | null;
  created_by_location: string | null;
  channel: string;
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

export async function createLead(db: Knex, data: CreateLeadInput): Promise<Lead> {
  const phone = normalizePhone(data.phone);
  return leadRepository.createLead(db, {
    ...data,
    phone,
    score: 0,
    current_pipeline: 'none',
    contact_status: 'active',
    duplicate_status: 'none',
  });
}

export async function getLead(db: Knex, id: string): Promise<Lead | null> {
  return leadRepository.findById(db, id);
}

export async function updateLead(db: Knex, id: string, fields: UpdateLeadInput): Promise<Lead> {
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

  return leadRepository.updateLead(db, id, fields);
}

export async function archiveLead(db: Knex, id: string): Promise<Lead> {
  return leadRepository.archiveLead(db, id);
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
