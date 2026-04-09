import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Campaign } from '../../src/repositories/campaigns.repo.js';
import type { LeadContact } from '../../src/services/audience-resolver.js';

// Mock repositories before importing the module under test
vi.mock('../../src/repositories/campaign-sends.repo.js', () => ({
  findByEmailJobRef: vi.fn(),
  insert: vi.fn(),
}));

vi.mock('../../src/repositories/campaign-recipients.repo.js', () => ({
  bulkInsert: vi.fn(),
  bulkInsertFull: vi.fn(),
}));

import { orchestrateAB } from '../../src/services/send-orchestrator.js';
import * as sendsRepo from '../../src/repositories/campaign-sends.repo.js';
import * as recipientsRepo from '../../src/repositories/campaign-recipients.repo.js';

const ENV = { EMAIL_SERVICE_URL: 'http://localhost:4000' };

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'camp-1',
    name: 'AB Test Campaign',
    status: 'sending',
    template_id: 'tpl-1',
    subject: 'Default Subject',
    segment_id: null,
    audience_filter: null,
    audience_snapshot_id: null,
    scheduled_for: null,
    orchestrate_job_id: null,
    ab_enabled: true,
    ab_mode: 'holdout',
    ab_test_split_pct: 10,
    ab_winner_delay_hours: 4,
    ab_variant_a_subject: 'Subject A',
    ab_variant_b_subject: 'Subject B',
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

function makeLeads(count: number, locationId: string): LeadContact[] {
  const leads: LeadContact[] = [];
  for (let i = 0; i < count; i++) {
    leads.push({
      id: `lead-${locationId}-${i}`,
      email: `lead-${locationId}-${i}@test.com`,
      first_name: 'Test',
      location_id: locationId,
    });
  }
  return leads;
}

function jsonResponse(data: unknown, status = 202): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fakeDb() {
  const trx = {};
  const db = {
    transaction: vi.fn(async (fn: (trx: unknown) => Promise<void>) => {
      await fn(trx);
    }),
    _trx: trx,
  };
  return db;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.mocked(sendsRepo.findByEmailJobRef).mockResolvedValue(null);
  vi.mocked(sendsRepo.insert).mockImplementation(async (_db, data) => ({
    id: 'send-1',
    ...data,
  }) as never);
  vi.mocked(recipientsRepo.bulkInsertFull).mockResolvedValue(undefined);
});

describe('orchestrateAB', () => {
  it('holdout floor rounding — 101 leads, test_split_pct=10 → A=10, B=10, holdout=81', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ job_id: 'ej-1' }),
    ) as unknown as typeof fetch;

    const db = fakeDb();
    const leads = makeLeads(101, 'loc-1');
    const grouped = new Map([['loc-1', leads]]);

    const campaign = makeCampaign({ ab_test_split_pct: 10 });
    await orchestrateAB(db as never, campaign, grouped, ENV);

    // Check campaign_sends inserts: A and B variants
    const sendInserts = vi.mocked(sendsRepo.insert).mock.calls;
    const variantASend = sendInserts.find((c) => c[1].variant === 'A');
    const variantBSend = sendInserts.find((c) => c[1].variant === 'B');

    expect(variantASend).toBeDefined();
    expect(variantBSend).toBeDefined();
    expect(variantASend![1].total_recipients).toBe(10);
    expect(variantBSend![1].total_recipients).toBe(10);

    // Check recipients: A=10, B=10, holdout=81
    const recipientCalls = vi.mocked(recipientsRepo.bulkInsertFull).mock.calls;
    expect(recipientCalls).toHaveLength(1);
    const allRecipients = recipientCalls[0]![1];
    expect(allRecipients).toHaveLength(101);

    const variantARecipients = allRecipients.filter((r: { variant: string | null }) => r.variant === 'A');
    const variantBRecipients = allRecipients.filter((r: { variant: string | null }) => r.variant === 'B');
    const holdoutRecipients = allRecipients.filter((r: { variant: string | null }) => r.variant === 'holdout');

    expect(variantARecipients).toHaveLength(10);
    expect(variantBRecipients).toHaveLength(10);
    expect(holdoutRecipients).toHaveLength(81);
  });

  it('full_split floor(n/2) — 101 leads → A=50, B=51', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ job_id: 'ej-1' }),
    ) as unknown as typeof fetch;

    const db = fakeDb();
    const leads = makeLeads(101, 'loc-1');
    const grouped = new Map([['loc-1', leads]]);

    const campaign = makeCampaign({ ab_mode: 'full_split', ab_test_split_pct: null });
    await orchestrateAB(db as never, campaign, grouped, ENV);

    // Check campaign_sends inserts
    const sendInserts = vi.mocked(sendsRepo.insert).mock.calls;
    const variantASend = sendInserts.find((c) => c[1].variant === 'A');
    const variantBSend = sendInserts.find((c) => c[1].variant === 'B');

    expect(variantASend![1].total_recipients).toBe(50);
    expect(variantBSend![1].total_recipients).toBe(51);

    // Check recipients: all sent, no holdout
    const recipientCalls = vi.mocked(recipientsRepo.bulkInsertFull).mock.calls;
    const allRecipients = recipientCalls[0]![1];
    expect(allRecipients).toHaveLength(101);

    const variantARecipients = allRecipients.filter((r: { variant: string | null }) => r.variant === 'A');
    const variantBRecipients = allRecipients.filter((r: { variant: string | null }) => r.variant === 'B');
    const holdoutRecipients = allRecipients.filter((r: { variant: string | null }) => r.variant === 'holdout');

    expect(variantARecipients).toHaveLength(50);
    expect(variantBRecipients).toHaveLength(51);
    expect(holdoutRecipients).toHaveLength(0);

    // All recipients have sent_at set (not null)
    for (const r of allRecipients) {
      expect((r as { sent_at: Date | null }).sent_at).not.toBeNull();
    }
  });

  it('holdout recipients have sent_at=NULL in INSERT', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ job_id: 'ej-1' }),
    ) as unknown as typeof fetch;

    const db = fakeDb();
    const leads = makeLeads(20, 'loc-1');
    const grouped = new Map([['loc-1', leads]]);

    const campaign = makeCampaign({ ab_test_split_pct: 10 });
    await orchestrateAB(db as never, campaign, grouped, ENV);

    const recipientCalls = vi.mocked(recipientsRepo.bulkInsertFull).mock.calls;
    const allRecipients = recipientCalls[0]![1];

    const holdoutRecipients = allRecipients.filter(
      (r: { variant: string | null }) => r.variant === 'holdout',
    );
    const sentRecipients = allRecipients.filter(
      (r: { variant: string | null }) => r.variant === 'A' || r.variant === 'B',
    );

    // All holdout recipients must have sent_at = null
    for (const r of holdoutRecipients) {
      expect((r as { sent_at: Date | null }).sent_at).toBeNull();
    }

    // All A/B recipients must have sent_at set
    for (const r of sentRecipients) {
      expect((r as { sent_at: Date | null }).sent_at).not.toBeNull();
    }
  });

  it('crash recovery guard skips existing email_job_ref', async () => {
    // Both variants already exist
    vi.mocked(sendsRepo.findByEmailJobRef).mockResolvedValue({
      id: 'existing-send',
      campaign_id: 'camp-1',
      location_id: 'loc-1',
      variant: 'A',
      subject_used: 'Subject A',
      email_job_id: 'job-1',
      email_job_ref: 'camp-1:loc-1:A',
      status: 'sending',
      total_recipients: 5,
      sent_count: 0,
      failed_count: 0,
      started_at: null,
      completed_at: null,
    });

    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const db = fakeDb();
    const leads = makeLeads(10, 'loc-1');
    const grouped = new Map([['loc-1', leads]]);

    await orchestrateAB(db as never, makeCampaign(), grouped, ENV);

    // Email Service should never be called
    expect(fetchMock).not.toHaveBeenCalled();
    // No sends inserted
    expect(sendsRepo.insert).not.toHaveBeenCalled();
    // No recipients inserted
    expect(recipientsRepo.bulkInsertFull).not.toHaveBeenCalled();
  });
});
