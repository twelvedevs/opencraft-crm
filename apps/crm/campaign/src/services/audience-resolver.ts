/**
 * Audience resolver — fetches leads from Lead Service, evaluates them
 * through Audience Engine, and returns grouped recipients by location_id.
 */

import type { Campaign } from '../repositories/campaigns.repo.js';

export interface LeadContact {
  id: string;
  email: string;
  first_name: string;
  location_id: string;
}

interface Env {
  LEAD_SERVICE_URL: string;
  AUDIENCE_ENGINE_URL: string;
}

interface FilterCondition {
  field: string;
  op: string;
  value: unknown;
}

const LEAD_PAGE_LIMIT = 200;
const PRE_FILTER_FIELDS = new Set(['location_id', 'pipeline', 'stage']);

/**
 * Extract top-level filter conditions that can be used as Lead Service
 * query params for pre-filtering (optimization — not required for correctness).
 */
export function extractPreFilters(
  audienceFilter: Record<string, unknown> | null,
): Record<string, string> {
  const params: Record<string, string> = {};
  if (!audienceFilter) return params;

  const conditions = audienceFilter['conditions'] as FilterCondition[] | undefined;
  if (!Array.isArray(conditions)) return params;

  for (const cond of conditions) {
    if (
      cond &&
      typeof cond.field === 'string' &&
      PRE_FILTER_FIELDS.has(cond.field) &&
      (cond.op === 'eq' || cond.op === '=') &&
      cond.value != null
    ) {
      params[cond.field] = String(cond.value);
    }
  }

  return params;
}

/**
 * Fetch all active leads from Lead Service via paginated GET /leads calls.
 */
async function fetchAllLeads(
  env: Env,
  preFilterParams: Record<string, string>,
): Promise<LeadContact[]> {
  const allLeads: LeadContact[] = [];
  let cursor: string | null = null;

  while (true) {
    const url = new URL('/leads', env.LEAD_SERVICE_URL);
    url.searchParams.set('contact_status', 'active');
    url.searchParams.set('limit', String(LEAD_PAGE_LIMIT));
    if (cursor !== null) {
      url.searchParams.set('cursor', cursor);
    }
    for (const [key, value] of Object.entries(preFilterParams)) {
      url.searchParams.set(key, value);
    }

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Lead Service returned ${res.status}: ${await res.text()}`);
    }

    const body = (await res.json()) as {
      data: LeadContact[];
      nextCursor: string | null;
    };
    allLeads.push(...body.data);

    if (body.nextCursor === null || body.nextCursor === undefined) break;
    cursor = body.nextCursor;
  }

  return allLeads;
}

/**
 * Submit lead batches to Audience Engine for evaluation and return the snapshot_id.
 * Named segments use POST /audiences/segments/:id/evaluate.
 * Inline filters use POST /audiences/evaluate.
 */
async function evaluateAudience(
  env: Env,
  campaign: Campaign,
  leads: LeadContact[],
  snapshotId: string,
): Promise<void> {
  const batchSize = LEAD_PAGE_LIMIT;

  for (let i = 0; i < leads.length; i += batchSize) {
    const batch = leads.slice(i, i + batchSize);
    const done = i + batchSize >= leads.length;
    const entities = batch.map((l) => ({ id: l.id }));

    let url: string;
    let body: Record<string, unknown>;

    if (campaign.segment_id) {
      url = `${env.AUDIENCE_ENGINE_URL}/audiences/segments/${campaign.segment_id}/evaluate`;
      body = { snapshot_id: snapshotId, entities, done };
    } else {
      url = `${env.AUDIENCE_ENGINE_URL}/audiences/evaluate`;
      body = {
        snapshot_id: snapshotId,
        filter: campaign.audience_filter,
        entities,
        snapshot: true,
        done,
      };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Audience Engine returned ${res.status}: ${await res.text()}`);
    }
  }
}

/**
 * Fetch matched lead IDs from the Audience Engine snapshot (paginated).
 */
async function fetchMatchedIds(
  env: Env,
  snapshotId: string,
): Promise<string[]> {
  const matchedIds: string[] = [];
  let offset = 0;

  while (true) {
    const url = new URL(
      `/audiences/snapshots/${snapshotId}`,
      env.AUDIENCE_ENGINE_URL,
    );
    url.searchParams.set('limit', String(LEAD_PAGE_LIMIT));
    url.searchParams.set('offset', String(offset));

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Audience Engine snapshot returned ${res.status}: ${await res.text()}`);
    }

    const body = (await res.json()) as { entity_ids: string[] };
    const ids = body.entity_ids;

    matchedIds.push(...ids);

    if (ids.length < LEAD_PAGE_LIMIT) break;
    offset += LEAD_PAGE_LIMIT;
  }

  return matchedIds;
}

/**
 * Batch-fetch lead contact data from Lead Service by IDs.
 */
async function fetchLeadsByIds(
  env: Env,
  ids: string[],
): Promise<LeadContact[]> {
  const leads: LeadContact[] = [];

  for (let i = 0; i < ids.length; i += LEAD_PAGE_LIMIT) {
    const chunk = ids.slice(i, i + LEAD_PAGE_LIMIT);
    const url = new URL('/leads', env.LEAD_SERVICE_URL);
    url.searchParams.set('ids', chunk.join(','));

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Lead Service (by ids) returned ${res.status}: ${await res.text()}`);
    }

    const body = (await res.json()) as { data: LeadContact[] };
    leads.push(...body.data);
  }

  return leads;
}

/**
 * Resolve audience for a campaign:
 * 1. Fetch all leads from Lead Service (paginated)
 * 2. Submit to Audience Engine for evaluation
 * 3. Fetch matched lead IDs from snapshot
 * 4. Batch-fetch contact data for matched leads
 * 5. Group by location_id
 */
export async function resolveAudience(
  _db: unknown,
  campaign: Campaign,
  env: Env,
): Promise<{ snapshotId: string; groupedByLocation: Map<string, LeadContact[]> }> {
  const snapshotId = crypto.randomUUID();

  // Step 1: Pre-filter extraction (optimization)
  const preFilterParams = extractPreFilters(campaign.audience_filter);

  // Step 2: Fetch all active leads
  const allLeads = await fetchAllLeads(env, preFilterParams);

  // Step 3: Evaluate through Audience Engine
  await evaluateAudience(env, campaign, allLeads, snapshotId);

  // Step 4: Fetch matched lead IDs from snapshot
  const matchedIds = await fetchMatchedIds(env, snapshotId);

  // Step 5: Batch-fetch contact data for matched leads
  const matchedLeads = await fetchLeadsByIds(env, matchedIds);

  // Step 6: Group by location_id
  const groupedByLocation = new Map<string, LeadContact[]>();
  for (const lead of matchedLeads) {
    const existing = groupedByLocation.get(lead.location_id);
    if (existing) {
      existing.push(lead);
    } else {
      groupedByLocation.set(lead.location_id, [lead]);
    }
  }

  return { snapshotId, groupedByLocation };
}
