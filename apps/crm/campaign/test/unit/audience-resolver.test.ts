import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveAudience,
  extractPreFilters,
  type LeadContact,
} from '../../src/services/audience-resolver.js';
import type { Campaign } from '../../src/repositories/campaigns.repo.js';

const ENV = {
  LEAD_SERVICE_URL: 'http://localhost:3000',
  AUDIENCE_ENGINE_URL: 'http://localhost:9998',
};

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'camp-1',
    name: 'Test Campaign',
    status: 'sending',
    template_id: 'tpl-1',
    subject: 'Hello',
    segment_id: null,
    audience_filter: { conditions: [] },
    audience_snapshot_id: null,
    scheduled_for: null,
    orchestrate_job_id: null,
    ab_enabled: false,
    ab_mode: null,
    ab_test_split_pct: null,
    ab_winner_delay_hours: 0,
    ab_variant_a_subject: null,
    ab_variant_b_subject: null,
    ab_phase: null,
    ab_winner: null,
    ab_decision_at: null,
    ab_opens_a: 0,
    ab_opens_b: 0,
    ab_winner_job_id: null,
    created_by: 'user-1',
    approved_by: null,
    approved_at: null,
    sent_at: null,
    completed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeLead(id: string, locationId: string): LeadContact {
  return {
    id,
    email: `${id}@test.com`,
    first_name: 'Test',
    location_id: locationId,
  };
}

describe('extractPreFilters', () => {
  it('extracts location_id from audience_filter conditions', () => {
    const filter = {
      conditions: [
        { field: 'location_id', op: 'eq', value: 'loc-1' },
      ],
    };
    const params = extractPreFilters(filter);
    expect(params).toEqual({ location_id: 'loc-1' });
  });

  it('extracts multiple pre-filter fields', () => {
    const filter = {
      conditions: [
        { field: 'location_id', op: 'eq', value: 'loc-1' },
        { field: 'pipeline', op: '=', value: 'new_patient' },
        { field: 'stage', op: 'eq', value: 'contacted' },
      ],
    };
    const params = extractPreFilters(filter);
    expect(params).toEqual({
      location_id: 'loc-1',
      pipeline: 'new_patient',
      stage: 'contacted',
    });
  });

  it('ignores fields not in pre-filter set', () => {
    const filter = {
      conditions: [
        { field: 'email', op: 'eq', value: 'test@test.com' },
        { field: 'location_id', op: 'eq', value: 'loc-1' },
      ],
    };
    const params = extractPreFilters(filter);
    expect(params).toEqual({ location_id: 'loc-1' });
  });

  it('ignores non-equality operators', () => {
    const filter = {
      conditions: [
        { field: 'location_id', op: 'contains', value: 'loc' },
      ],
    };
    const params = extractPreFilters(filter);
    expect(params).toEqual({});
  });

  it('returns empty params for null filter', () => {
    expect(extractPreFilters(null)).toEqual({});
  });

  it('returns empty params when no conditions array', () => {
    expect(extractPreFilters({ other: 'value' })).toEqual({});
  });
});

describe('resolveAudience', () => {
  let fetchCalls: { url: string; method: string; body?: unknown }[];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      let body: unknown;
      if (init?.body) {
        body = JSON.parse(init.body as string);
      }
      fetchCalls.push({ url, method, body });
      return handler(url, init);
    }) as typeof fetch;
  }

  function jsonResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('pagination loop calls Lead Service correct page count for 1050 leads', async () => {
    const leads: LeadContact[] = [];
    for (let i = 0; i < 1050; i++) {
      leads.push(makeLead(`lead-${i}`, 'loc-1'));
    }

    const matchedIds = leads.map((l) => l.id);

    mockFetch((url) => {
      // Lead Service — paginated fetch
      if (url.includes('/leads') && url.includes('contact_status')) {
        const parsed = new URL(url);
        const offset = parseInt(parsed.searchParams.get('offset') ?? '0', 10);
        const limit = parseInt(parsed.searchParams.get('limit') ?? '500', 10);
        const page = leads.slice(offset, offset + limit);
        return jsonResponse({ items: page });
      }

      // Audience Engine — evaluate
      if (url.includes('/audiences/evaluate')) {
        return jsonResponse({ ok: true });
      }

      // Audience Engine — snapshot (matched IDs)
      if (url.includes('/audiences/snapshots/')) {
        const parsed = new URL(url);
        const offset = parseInt(parsed.searchParams.get('offset') ?? '0', 10);
        const limit = parseInt(parsed.searchParams.get('limit') ?? '500', 10);
        const page = matchedIds.slice(offset, offset + limit);
        return jsonResponse({ entity_ids: page });
      }

      // Lead Service — fetch by IDs
      if (url.includes('/leads') && url.includes('ids=')) {
        const parsed = new URL(url);
        const ids = parsed.searchParams.get('ids')!.split(',');
        const result = leads.filter((l) => ids.includes(l.id));
        return jsonResponse({ items: result });
      }

      return jsonResponse({ error: 'unexpected' }, 500);
    });

    const campaign = makeCampaign();
    const result = await resolveAudience(null, campaign, ENV);

    // Lead Service paginated calls: 500 + 500 + 50 = 3 pages
    const leadFetchCalls = fetchCalls.filter(
      (c) => c.url.includes('/leads') && c.url.includes('contact_status'),
    );
    expect(leadFetchCalls).toHaveLength(3);

    expect(result.groupedByLocation.get('loc-1')?.length).toBe(1050);
  });

  it('final batch sent to Audience Engine has done=true', async () => {
    const leads = [makeLead('lead-1', 'loc-1'), makeLead('lead-2', 'loc-1')];

    mockFetch((url) => {
      if (url.includes('/leads') && url.includes('contact_status')) {
        return jsonResponse({ items: leads });
      }
      if (url.includes('/audiences/evaluate')) {
        return jsonResponse({ ok: true });
      }
      if (url.includes('/audiences/snapshots/')) {
        return jsonResponse({ entity_ids: ['lead-1', 'lead-2'] });
      }
      if (url.includes('/leads') && url.includes('ids=')) {
        return jsonResponse({ items: leads });
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    });

    const campaign = makeCampaign();
    await resolveAudience(null, campaign, ENV);

    // Only one batch (2 leads < 500), so it should have done=true
    const evaluateCalls = fetchCalls.filter((c) => c.url.includes('/audiences/evaluate'));
    expect(evaluateCalls).toHaveLength(1);
    expect((evaluateCalls[0]!.body as Record<string, unknown>).done).toBe(true);
  });

  it('pre-filter extraction correctly picks location_id from audience_filter', async () => {
    const leads = [makeLead('lead-1', 'loc-42')];

    mockFetch((url) => {
      if (url.includes('/leads') && url.includes('contact_status')) {
        return jsonResponse({ items: leads });
      }
      if (url.includes('/audiences/evaluate')) {
        return jsonResponse({ ok: true });
      }
      if (url.includes('/audiences/snapshots/')) {
        return jsonResponse({ entity_ids: ['lead-1'] });
      }
      if (url.includes('/leads') && url.includes('ids=')) {
        return jsonResponse({ items: leads });
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    });

    const campaign = makeCampaign({
      audience_filter: {
        conditions: [{ field: 'location_id', op: 'eq', value: 'loc-42' }],
      },
    });

    await resolveAudience(null, campaign, ENV);

    const leadFetchCalls = fetchCalls.filter(
      (c) => c.url.includes('/leads') && c.url.includes('contact_status'),
    );
    expect(leadFetchCalls).toHaveLength(1);
    const parsed = new URL(leadFetchCalls[0]!.url);
    expect(parsed.searchParams.get('location_id')).toBe('loc-42');
  });

  it('Audience Engine 4xx response throws an error', async () => {
    const leads = [makeLead('lead-1', 'loc-1')];

    mockFetch((url) => {
      if (url.includes('/leads') && url.includes('contact_status')) {
        return jsonResponse({ items: leads });
      }
      if (url.includes('/audiences/evaluate')) {
        return jsonResponse({ error: 'bad_filter' }, 422);
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    });

    const campaign = makeCampaign();

    await expect(resolveAudience(null, campaign, ENV)).rejects.toThrow(
      /Audience Engine returned 422/,
    );
  });

  it('uses segment evaluate endpoint when segment_id is set', async () => {
    const leads = [makeLead('lead-1', 'loc-1')];

    mockFetch((url) => {
      if (url.includes('/leads') && url.includes('contact_status')) {
        return jsonResponse({ items: leads });
      }
      if (url.includes('/audiences/segments/seg-1/evaluate')) {
        return jsonResponse({ ok: true });
      }
      if (url.includes('/audiences/snapshots/')) {
        return jsonResponse({ entity_ids: ['lead-1'] });
      }
      if (url.includes('/leads') && url.includes('ids=')) {
        return jsonResponse({ items: leads });
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    });

    const campaign = makeCampaign({
      segment_id: 'seg-1',
      audience_filter: null,
    });

    await resolveAudience(null, campaign, ENV);

    const evaluateCalls = fetchCalls.filter((c) => c.url.includes('/audiences/segments/seg-1/evaluate'));
    expect(evaluateCalls).toHaveLength(1);
    expect((evaluateCalls[0]!.body as Record<string, unknown>).snapshot_id).toBeDefined();
    expect((evaluateCalls[0]!.body as Record<string, unknown>).done).toBe(true);
  });
});
