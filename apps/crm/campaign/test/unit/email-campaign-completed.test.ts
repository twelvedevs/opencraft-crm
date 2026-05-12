import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CampaignSend } from '../../src/repositories/campaign-sends.repo.js';
import type { Campaign } from '../../src/repositories/campaigns.repo.js';

// Mock repositories and publisher before importing the module under test
vi.mock('../../src/repositories/campaign-sends.repo.js', () => ({
  findByEmailJobId: vi.fn(),
  update: vi.fn(),
  countNonTerminalSends: vi.fn(),
  findAllByCampaignId: vi.fn(),
}));

vi.mock('../../src/repositories/campaigns.repo.js', () => ({
  findById: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../../src/repositories/campaign-events.repo.js', () => ({
  insertEvent: vi.fn(),
}));

vi.mock('../../src/events/publisher.js', () => ({
  publishCampaignSent: vi.fn(),
}));

import { handleEmailCampaignCompleted } from '../../src/handlers/email-campaign-completed.handler.js';
import type { EmailCampaignCompletedPayload } from '../../src/handlers/email-campaign-completed.handler.js';
import * as sendsRepo from '../../src/repositories/campaign-sends.repo.js';
import * as campaignsRepo from '../../src/repositories/campaigns.repo.js';
import * as eventsRepo from '../../src/repositories/campaign-events.repo.js';
import * as publisher from '../../src/events/publisher.js';

function makeSend(overrides: Partial<CampaignSend> = {}): CampaignSend {
  return {
    id: 'send-1',
    campaign_id: 'camp-1',
    location_id: 'loc-1',
    variant: null,
    subject_used: 'Hello',
    email_job_id: 'job-1',
    email_job_ref: 'camp-1:loc-1',
    status: 'sending',
    total_recipients: 100,
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
    sent_at: new Date(),
    completed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makePayload(overrides: Partial<EmailCampaignCompletedPayload> = {}): EmailCampaignCompletedPayload {
  return {
    job_id: 'job-1',
    status: 'completed',
    sent_count: 95,
    failed_count: 5,
    total_recipients: 100,
    completed_at: '2026-04-08T12:00:00Z',
    ...overrides,
  };
}

const db = {} as never;
const bus = {
  publish: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn(),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
};

beforeEach(() => {
  vi.clearAllMocks();

  // Default: send found, campaign found, no in-flight sends, all sends terminal
  vi.mocked(sendsRepo.findByEmailJobId).mockResolvedValue(makeSend());
  vi.mocked(sendsRepo.update).mockResolvedValue(makeSend());
  vi.mocked(campaignsRepo.findById).mockResolvedValue(makeCampaign());
  vi.mocked(campaignsRepo.update).mockResolvedValue(makeCampaign());
  vi.mocked(sendsRepo.countNonTerminalSends).mockResolvedValue(0);
  vi.mocked(sendsRepo.findAllByCampaignId).mockResolvedValue([
    makeSend({ status: 'completed', sent_count: 95, failed_count: 5 }),
  ]);
  vi.mocked(eventsRepo.insertEvent).mockResolvedValue({
    id: 'evt-1',
    campaign_id: 'camp-1',
    from_status: 'sending',
    to_status: 'completed',
    actor_id: null,
    comment: null,
    created_at: new Date(),
  });
  vi.mocked(publisher.publishCampaignSent).mockResolvedValue(undefined);
});

describe('handleEmailCampaignCompleted', () => {
  it('returns early when no campaign_sends row found for job_id', async () => {
    vi.mocked(sendsRepo.findByEmailJobId).mockResolvedValue(null);

    await handleEmailCampaignCompleted(makePayload(), db, bus);

    // Should not update anything
    expect(sendsRepo.update).not.toHaveBeenCalled();
    expect(campaignsRepo.update).not.toHaveBeenCalled();
    expect(publisher.publishCampaignSent).not.toHaveBeenCalled();
  });

  it('terminal status = completed when all sends completed', async () => {
    vi.mocked(sendsRepo.findAllByCampaignId).mockResolvedValue([
      makeSend({ status: 'completed', sent_count: 100, failed_count: 0 }),
    ]);

    await handleEmailCampaignCompleted(makePayload({ status: 'completed' }), db, bus);

    // campaign_sends updated
    expect(sendsRepo.update).toHaveBeenCalledWith(db, 'send-1', expect.objectContaining({
      status: 'completed',
      sent_count: 95,
      failed_count: 5,
    }));

    // campaign.sent published
    expect(publisher.publishCampaignSent).toHaveBeenCalledWith(bus, expect.objectContaining({
      campaign_id: 'camp-1',
      location_id: 'loc-1',
    }));

    // Campaign updated to terminal status
    expect(campaignsRepo.update).toHaveBeenCalledWith(db, 'camp-1', expect.objectContaining({
      status: 'completed',
    }));

    // Audit event inserted
    expect(eventsRepo.insertEvent).toHaveBeenCalledWith(db, expect.objectContaining({
      campaign_id: 'camp-1',
      from_status: 'sending',
      to_status: 'completed',
      actor_id: null,
    }));
  });

  it('terminal status = completed_with_errors when mixed results', async () => {
    vi.mocked(sendsRepo.findAllByCampaignId).mockResolvedValue([
      makeSend({ id: 'send-1', location_id: 'loc-1', status: 'completed', sent_count: 90, failed_count: 10 }),
      makeSend({ id: 'send-2', location_id: 'loc-2', status: 'failed', sent_count: 0, failed_count: 50 }),
    ]);

    await handleEmailCampaignCompleted(makePayload(), db, bus);

    expect(campaignsRepo.update).toHaveBeenCalledWith(db, 'camp-1', expect.objectContaining({
      status: 'completed_with_errors',
    }));
    expect(eventsRepo.insertEvent).toHaveBeenCalledWith(db, expect.objectContaining({
      to_status: 'completed_with_errors',
    }));
  });

  it('terminal status = failed when all sends failed', async () => {
    vi.mocked(sendsRepo.findAllByCampaignId).mockResolvedValue([
      makeSend({ id: 'send-1', location_id: 'loc-1', status: 'failed', sent_count: 0, failed_count: 50 }),
      makeSend({ id: 'send-2', location_id: 'loc-2', status: 'failed', sent_count: 0, failed_count: 50 }),
    ]);

    await handleEmailCampaignCompleted(makePayload({ status: 'failed' }), db, bus);

    expect(campaignsRepo.update).toHaveBeenCalledWith(db, 'camp-1', expect.objectContaining({
      status: 'failed',
    }));
    expect(eventsRepo.insertEvent).toHaveBeenCalledWith(db, expect.objectContaining({
      to_status: 'failed',
    }));
  });

  it('terminal status = failed when all sends are cancelled (no completions)', async () => {
    vi.mocked(sendsRepo.findAllByCampaignId).mockResolvedValue([
      makeSend({ id: 'send-1', location_id: 'loc-1', status: 'cancelled', sent_count: 0, failed_count: 0 }),
      makeSend({ id: 'send-2', location_id: 'loc-2', status: 'cancelled', sent_count: 0, failed_count: 0 }),
    ]);

    await handleEmailCampaignCompleted(makePayload({ status: 'cancelled' }), db, bus);

    expect(campaignsRepo.update).toHaveBeenCalledWith(db, 'camp-1', expect.objectContaining({
      status: 'failed',
    }));
    expect(eventsRepo.insertEvent).toHaveBeenCalledWith(db, expect.objectContaining({
      to_status: 'failed',
    }));
  });

  it('returns early without status change when sends still in flight', async () => {
    vi.mocked(sendsRepo.countNonTerminalSends).mockResolvedValue(2);

    await handleEmailCampaignCompleted(makePayload(), db, bus);

    // campaign_sends row updated
    expect(sendsRepo.update).toHaveBeenCalled();
    // campaign.sent published
    expect(publisher.publishCampaignSent).toHaveBeenCalled();
    // But campaign NOT updated to terminal status
    expect(campaignsRepo.update).not.toHaveBeenCalled();
    expect(eventsRepo.insertEvent).not.toHaveBeenCalled();
  });

  it('returns early when ab_phase = testing', async () => {
    vi.mocked(campaignsRepo.findById).mockResolvedValue(makeCampaign({ ab_phase: 'testing' }));

    await handleEmailCampaignCompleted(makePayload(), db, bus);

    // campaign_sends row updated and event published
    expect(sendsRepo.update).toHaveBeenCalled();
    expect(publisher.publishCampaignSent).toHaveBeenCalled();
    // But no terminal status determination
    expect(sendsRepo.countNonTerminalSends).not.toHaveBeenCalled();
    expect(campaignsRepo.update).not.toHaveBeenCalled();
    expect(eventsRepo.insertEvent).not.toHaveBeenCalled();
  });
});
