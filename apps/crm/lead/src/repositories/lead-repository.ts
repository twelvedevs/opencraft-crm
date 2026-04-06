import type { Knex } from 'knex';
import { env } from '../env.js';

export interface Lead {
  id: string;
  location_id: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string | null;
  treatment_interest: string | null;
  date_of_birth: string | null;
  channel: string;
  contact_status: string;
  current_pipeline: string;
  current_stage: string | null;
  last_activity_at: string | null;
  score: number;
  duplicate_status: string;
  duplicate_of_id: string | null;
  merged_into_id: string | null;
  archived_at: string | null;
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
  created_at: string;
  updated_at: string;
}

export type CreateLeadData = Omit<Lead, 'id' | 'created_at' | 'updated_at'>;

export type UpdateableLeadFields = Partial<
  Pick<
    Lead,
    | 'first_name'
    | 'last_name'
    | 'phone'
    | 'email'
    | 'treatment_interest'
    | 'date_of_birth'
    | 'location_id'
    | 'contact_status'
    | 'current_pipeline'
    | 'current_stage'
    | 'last_activity_at'
    | 'score'
    | 'duplicate_status'
    | 'duplicate_of_id'
    | 'merged_into_id'
    | 'archived_at'
  >
>;

export interface ListLeadsParams {
  locationIds?: string[];
  pipeline?: string;
  stage?: string;
  status?: 'active' | 'archived';
  contactStatus?: string;
  channel?: string;
  tagIds?: string[];
  q?: string;
  includeArchived?: boolean;
  sort?: 'score' | 'created_at' | 'last_activity_at';
  cursor?: string;
  limit?: number;
}

const TABLE = 'crm_leads.leads';

export function createLead(db: Knex, data: CreateLeadData): Promise<Lead> {
  return db(TABLE)
    .insert(data)
    .returning('*')
    .then((rows) => rows[0] as Lead);
}

export function findById(db: Knex, id: string): Promise<Lead | null> {
  return db(TABLE)
    .where({ id })
    .first()
    .then((row) => (row as Lead) ?? null);
}

export function findByPhone(db: Knex, phone: string, excludeId?: string): Promise<Lead[]> {
  const query = db(TABLE)
    .where({ phone })
    .whereNull('archived_at')
    .whereNull('merged_into_id');
  if (excludeId) {
    query.whereNot({ id: excludeId });
  }
  return query.then((rows) => rows as Lead[]);
}

export function findByEmail(db: Knex, email: string, excludeId?: string): Promise<Lead[]> {
  const query = db(TABLE)
    .whereRaw('LOWER(email) = LOWER(?)', [email])
    .whereNull('archived_at')
    .whereNull('merged_into_id');
  if (excludeId) {
    query.whereNot({ id: excludeId });
  }
  return query.then((rows) => rows as Lead[]);
}

export function findByAdPlatformLeadId(db: Knex, adPlatformLeadId: string): Promise<Lead | null> {
  return db(TABLE)
    .where({ ad_platform_lead_id: adPlatformLeadId })
    .first()
    .then((row) => (row as Lead) ?? null);
}

export function updateLead(db: Knex, id: string, fields: Partial<UpdateableLeadFields>): Promise<Lead> {
  return db(TABLE)
    .where({ id })
    .update({ ...fields, updated_at: db.fn.now() })
    .returning('*')
    .then((rows) => rows[0] as Lead);
}

export function archiveLead(db: Knex, id: string): Promise<Lead> {
  return db(TABLE)
    .where({ id })
    .update({ archived_at: db.fn.now(), updated_at: db.fn.now() })
    .returning('*')
    .then((rows) => rows[0] as Lead);
}

interface CursorData {
  lastSeenId: string;
  lastSeenSortValue: string | number;
}

function decodeCursor(cursor: string): CursorData {
  const json = Buffer.from(cursor, 'base64').toString('utf-8');
  return JSON.parse(json) as CursorData;
}

function encodeCursor(data: CursorData): string {
  return Buffer.from(JSON.stringify(data)).toString('base64');
}

export async function listLeads(
  db: Knex,
  params: ListLeadsParams,
): Promise<{ leads: Lead[]; nextCursor: string | null }> {
  const {
    locationIds,
    pipeline,
    stage,
    status,
    contactStatus,
    channel,
    tagIds,
    q,
    includeArchived = false,
    sort = 'score',
    cursor,
    limit = 50,
  } = params;

  const effectiveLimit = Math.min(limit, 200);

  let query = db(TABLE).select('crm_leads.leads.*');

  // Location scoping
  if (locationIds && locationIds.length > 0) {
    query = query.whereIn('crm_leads.leads.location_id', locationIds);
  }

  // Active/archived filtering
  if (!includeArchived) {
    query = query.whereNull('crm_leads.leads.archived_at');
  }
  query = query.whereNull('crm_leads.leads.merged_into_id');

  // Filters
  if (pipeline) {
    query = query.where('crm_leads.leads.current_pipeline', pipeline);
  }
  if (stage) {
    query = query.where('crm_leads.leads.current_stage', stage);
  }
  if (status === 'archived') {
    query = query.whereNotNull('crm_leads.leads.archived_at');
  }
  if (contactStatus) {
    query = query.where('crm_leads.leads.contact_status', contactStatus);
  }
  if (channel) {
    query = query.where('crm_leads.leads.channel', channel);
  }

  // Tag filter
  if (tagIds && tagIds.length > 0) {
    query = query
      .join('crm_leads.lead_tags as lt', 'lt.lead_id', 'crm_leads.leads.id')
      .whereIn('lt.tag_id', tagIds);
  }

  // Trigram search
  if (q) {
    const threshold = env.SEARCH_SIMILARITY_THRESHOLD;
    query = query.where(function (this: Knex.QueryBuilder) {
      this.whereRaw(
        `similarity(crm_leads.leads.first_name || ' ' || crm_leads.leads.last_name, ?) > ?`,
        [q, threshold],
      )
        .orWhereRaw(`similarity(crm_leads.leads.phone, ?) > ?`, [q, threshold])
        .orWhereRaw(`similarity(crm_leads.leads.email, ?) > ?`, [q, threshold]);
    });
  }

  // Cursor pagination
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (sort === 'score') {
      query = query.whereRaw(
        `(crm_leads.leads.score, crm_leads.leads.id) < (?, ?)`,
        [decoded.lastSeenSortValue, decoded.lastSeenId],
      );
    } else if (sort === 'created_at') {
      query = query.whereRaw(
        `(crm_leads.leads.created_at, crm_leads.leads.id) < (?, ?)`,
        [decoded.lastSeenSortValue, decoded.lastSeenId],
      );
    } else if (sort === 'last_activity_at') {
      query = query.whereRaw(
        `(COALESCE(crm_leads.leads.last_activity_at, '-infinity'::timestamptz), crm_leads.leads.id) < (?, ?)`,
        [decoded.lastSeenSortValue, decoded.lastSeenId],
      );
    }
  }

  // Ordering
  if (q) {
    query = query.orderByRaw(
      `GREATEST(
        similarity(crm_leads.leads.first_name || ' ' || crm_leads.leads.last_name, ?),
        similarity(crm_leads.leads.phone, ?),
        similarity(crm_leads.leads.email, ?)
      ) DESC`,
      [q, q, q],
    );
  }

  if (sort === 'score') {
    query = query.orderBy('crm_leads.leads.score', 'desc').orderBy('crm_leads.leads.id', 'desc');
  } else if (sort === 'created_at') {
    query = query.orderBy('crm_leads.leads.created_at', 'desc').orderBy('crm_leads.leads.id', 'desc');
  } else if (sort === 'last_activity_at') {
    query = query
      .orderByRaw('crm_leads.leads.last_activity_at DESC NULLS LAST')
      .orderBy('crm_leads.leads.id', 'desc');
  }

  query = query.limit(effectiveLimit + 1);

  const rows = (await query) as Lead[];

  let nextCursor: string | null = null;
  if (rows.length > effectiveLimit) {
    rows.pop();
    const lastRow = rows[rows.length - 1];
    let lastSeenSortValue: string | number;
    if (sort === 'score') {
      lastSeenSortValue = lastRow.score;
    } else if (sort === 'created_at') {
      lastSeenSortValue = lastRow.created_at;
    } else {
      lastSeenSortValue = lastRow.last_activity_at ?? '-infinity';
    }
    nextCursor = encodeCursor({ lastSeenId: lastRow.id, lastSeenSortValue });
  }

  return { leads: rows, nextCursor };
}

export function findByPhones(db: Knex, phones: string[], locationIds: string[]): Promise<Lead[]> {
  let query = db(TABLE)
    .whereIn('phone', phones)
    .whereNull('archived_at')
    .whereNull('merged_into_id');
  if (locationIds.length > 0) {
    query = query.whereIn('location_id', locationIds);
  }
  return query.then((rows) => rows as Lead[]);
}

export function findByEmails(db: Knex, emails: string[], locationIds: string[]): Promise<Lead[]> {
  const lowered = emails.map((e) => e.toLowerCase());
  let query = db(TABLE)
    .whereRaw('LOWER(email) = ANY(?)', [lowered])
    .whereNull('archived_at')
    .whereNull('merged_into_id');
  if (locationIds.length > 0) {
    query = query.whereIn('location_id', locationIds);
  }
  return query.then((rows) => rows as Lead[]);
}

export async function findFlaggedDuplicates(
  db: Knex,
  locationIds: string[],
  cursor?: string,
  limit?: number,
): Promise<{ leads: Lead[]; nextCursor: string | null }> {
  const effectiveLimit = Math.min(limit ?? 50, 200);

  let query = db(TABLE)
    .where({ duplicate_status: 'flagged' })
    .whereNull('archived_at')
    .whereNull('merged_into_id');

  if (locationIds.length > 0) {
    query = query.whereIn('location_id', locationIds);
  }

  if (cursor) {
    const decoded = decodeCursor(cursor);
    query = query.whereRaw(
      `(created_at, id) < (?, ?)`,
      [decoded.lastSeenSortValue, decoded.lastSeenId],
    );
  }

  query = query
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(effectiveLimit + 1);

  const rows = (await query) as Lead[];

  let nextCursor: string | null = null;
  if (rows.length > effectiveLimit) {
    rows.pop();
    const lastRow = rows[rows.length - 1];
    nextCursor = encodeCursor({
      lastSeenId: lastRow.id,
      lastSeenSortValue: lastRow.created_at,
    });
  }

  return { leads: rows, nextCursor };
}

export function findByIds(db: Knex, ids: string[], locationIds: string[]): Promise<Lead[]> {
  let query = db(TABLE).whereIn('id', ids);
  if (locationIds.length > 0) {
    query = query.whereIn('location_id', locationIds);
  }
  return query.then((rows) => rows as Lead[]);
}
