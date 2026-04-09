import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CampaignSend } from '../../src/repositories/campaign-sends.repo.js';
import type { Campaign } from '../../src/repositories/campaigns.repo.js';

vi.mock('../../src/repositories/campaign-sends.repo.js', () => ({
  findByEmailJobId: vi.fn(),
}));

vi.mock('../../src/repositories/campaigns.repo.js', () => ({
  findById: vi.fn(),
  update: vi.fn(),
  incrementAbOpens: vi.fn(),
}));

import { handleEmailOpened } from '../../src/handlers/email-opened.handler.js';
import type { EmailOpenedPayload } from '../../src/handlers/email-opened.handler.js';
import * as sendsRepo from '../../src/repositories/campaign-sends.repo.js';
import * as campaignsRepo from '../../src/repositories/campaigns.repo.js';

function makeSend(overrides: Partial<CampaignSend> = {}): CampaignSend {
  return {
    id: 'send-1',
    campaign_id: 'camp-1',
    location_id: 'loc-1',
    variant: 'A',
    subject_used: 'Hello',
    email_job_id: 'job-1',
    email_job_ref: 'camp-1:loc-1:A',
    status: 'sending',
    total_recipients: 50,
    sent_count: 0,
    failed_count: 0,
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'camp-1',
    name: 'Test Campaign',
    status: 'sending',
    template_id: 'tpl-1',
    subject: 'Hello',
    segment_id: null,
    audience_filter: null,
    audience_snapshot_id: 'snap-1',
    scheduled_for: null,
    orchestrate_job_id: null,
    ab_enabled: true,
    ab_mode: 'holdout',
    ab_test_split_pct: 10,
    ab_winner_delay_hours: 4,
    ab_variant_a_subject: 'Subject A',
    ab_variant_b_subject: 'Subject B',
    ab_phase: 'testing',
    ab_winner: null,
    ab_decision_at: null,
    ab_opens_a: 0,
    ab_opens_b: 0,
    ab_winner_job_id: null,
    created_by: 'user-1',
    approved_by: null,
    approved_at: null,
    sent_at: new Date(),
    completed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makePayload(overrides: Partial<EmailOpenedPayload> = {}): EmailOpenedPayload {
  return {
    campaign_job_id: 'job-1',
    entity_type: 'campaign',
    entity_id: 'camp-1',
    ...overrides,
  };
}

const db = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendsRepo.findByEmailJobId).mockResolvedValue(makeSend());
  vi.mocked(campaignsRepo.findById).mockResolvedValue(makeCampaign());
  vi.mocked(campaignsRepo.update).mockResolvedValue(makeCampaign());
  vi.mocked(campaignsRepo.incrementAbOpens).mockResolvedValue(undefined);
});

describe('handleEmailOpened', () => {
  it('atomically increments ab_opens_a when variant = A', async () => {
    vi.mocked(sendsRepo.findByEmailJobId).mockResolvedValue(makeSend({ variant: 'A' }));

    await handleEmailOpened(makePayload(), db);

    expect(campaignsRepo.incrementAbOpens).toHaveBeenCalledWith(db, 'camp-1', 'A');
    expect(campaignsRepo.update).not.toHaveBeenCalled();
  });

  it('atomically increments ab_opens_b when variant = B', async () => {
    vi.mocked(sendsRepo.findByEmailJobId).mockResolvedValue(makeSend({ variant: 'B' }));

    await handleEmailOpened(makePayload(), db);

    expect(campaignsRepo.incrementAbOpens).toHaveBeenCalledWith(db, 'camp-1', 'B');
    expect(campaignsRepo.update).not.toHaveBeenCalled();
  });

  it('no-ops when variant = holdout', async () => {
    vi.mocked(sendsRepo.findByEmailJobId).mockResolvedValue(makeSend({ variant: 'holdout' }));

    await handleEmailOpened(makePayload(), db);

    expect(campaignsRepo.update).not.toHaveBeenCalled();
  });

  it('no-ops when ab_phase is not testing', async () => {
    vi.mocked(campaignsRepo.findById).mockResolvedValue(makeCampaign({ ab_phase: 'complete' }));

    await handleEmailOpened(makePayload(), db);

    expect(campaignsRepo.update).not.toHaveBeenCalled();
  });

  it('returns early when no campaign_sends row found', async () => {
    vi.mocked(sendsRepo.findByEmailJobId).mockResolvedValue(null);

    await handleEmailOpened(makePayload(), db);

    expect(campaignsRepo.findById).not.toHaveBeenCalled();
    expect(campaignsRepo.update).not.toHaveBeenCalled();
  });

  it('no-ops when campaign status is not sending', async () => {
    vi.mocked(campaignsRepo.findById).mockResolvedValue(makeCampaign({ status: 'completed' }));

    await handleEmailOpened(makePayload(), db);

    expect(campaignsRepo.update).not.toHaveBeenCalled();
  });
});
