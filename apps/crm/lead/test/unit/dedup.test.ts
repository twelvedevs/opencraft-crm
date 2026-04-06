import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/repositories/lead-repository.js', () => ({
  createLead: vi.fn(),
  findById: vi.fn(),
  updateLead: vi.fn(),
  archiveLead: vi.fn(),
  listLeads: vi.fn(),
  findByPhone: vi.fn(),
  findByEmail: vi.fn(),
  findByAdPlatformLeadId: vi.fn(),
}));

vi.mock('../../src/repositories/activity-repository.js', () => ({
  insertActivity: vi.fn(),
}));

vi.mock('../../src/events/publisher.js', () => ({
  publishLeadCreated: vi.fn(),
  publishLeadUpdated: vi.fn(),
  publishLeadArchived: vi.fn(),
}));

import type { Knex } from 'knex';
import type { EventBus } from '@ortho/event-bus';
import { createLead } from '../../src/services/lead-service.js';
import * as leadRepository from '../../src/repositories/lead-repository.js';

const db = {} as Knex;
const eventBus = { publish: vi.fn(), stop: vi.fn() } as unknown as EventBus;

const baseLead = {
  id: '11111111-1111-1111-1111-111111111111',
  location_id: 'loc-1',
  first_name: 'John',
  last_name: 'Doe',
  phone: '+15551234567',
  email: 'john@example.com',
  treatment_interest: null,
  date_of_birth: null,
  channel: 'website_form',
  contact_status: 'active',
  current_pipeline: 'none',
  current_stage: null,
  last_activity_at: null,
  score: 0,
  duplicate_status: 'none',
  duplicate_of_id: null,
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
  ad_platform_lead_id: null,
  created_by_location: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const input = {
  first_name: 'Jane',
  last_name: 'Smith',
  phone: '2125551234',
  email: 'jane@example.com',
  channel: 'website_form',
  location_id: 'loc-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(leadRepository.findByPhone).mockResolvedValue([]);
  vi.mocked(leadRepository.findByEmail).mockResolvedValue([]);
  vi.mocked(leadRepository.findByAdPlatformLeadId).mockResolvedValue(null);
});

describe('dedup logic in createLead', () => {
  it('ad_platform_lead_id match returns existing lead without inserting', async () => {
    const existingLead = { ...baseLead, ad_platform_lead_id: 'ad-123' };
    vi.mocked(leadRepository.findByAdPlatformLeadId).mockResolvedValue(existingLead);

    const result = await createLead(
      db,
      { ...input, ad_platform_lead_id: 'ad-123' },
      eventBus,
      'user-1',
    );

    expect(result).toEqual(existingLead);
    expect(leadRepository.createLead).not.toHaveBeenCalled();
  });

  it('phone match creates lead with duplicate_status=flagged and duplicate_of_id pointing to oldest match', async () => {
    const olderLead = { ...baseLead, id: 'older-id', created_at: '2025-01-01T00:00:00Z' };
    const newerLead = { ...baseLead, id: 'newer-id', created_at: '2026-01-01T00:00:00Z' };
    vi.mocked(leadRepository.findByPhone).mockResolvedValue([newerLead, olderLead]);

    const createdLead = { ...baseLead, duplicate_status: 'flagged', duplicate_of_id: 'older-id' };
    vi.mocked(leadRepository.createLead).mockResolvedValue(createdLead);

    await createLead(db, input, eventBus, 'user-1');

    expect(leadRepository.createLead).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        duplicate_status: 'flagged',
        duplicate_of_id: 'older-id',
      }),
    );
  });

  it('email match creates lead with duplicate_status=flagged', async () => {
    const emailMatch = { ...baseLead, id: 'email-match-id', email: 'jane@example.com' };
    vi.mocked(leadRepository.findByEmail).mockResolvedValue([emailMatch]);

    const createdLead = { ...baseLead, duplicate_status: 'flagged', duplicate_of_id: 'email-match-id' };
    vi.mocked(leadRepository.createLead).mockResolvedValue(createdLead);

    await createLead(db, input, eventBus, 'user-1');

    expect(leadRepository.createLead).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        duplicate_status: 'flagged',
        duplicate_of_id: 'email-match-id',
      }),
    );
  });

  it('both phone and email match uses oldest lead across both sets as duplicate_of_id', async () => {
    const phoneMatch = { ...baseLead, id: 'phone-id', created_at: '2026-02-01T00:00:00Z' };
    const emailMatch = { ...baseLead, id: 'email-id', created_at: '2025-06-01T00:00:00Z' };
    vi.mocked(leadRepository.findByPhone).mockResolvedValue([phoneMatch]);
    vi.mocked(leadRepository.findByEmail).mockResolvedValue([emailMatch]);

    const createdLead = { ...baseLead, duplicate_status: 'flagged', duplicate_of_id: 'email-id' };
    vi.mocked(leadRepository.createLead).mockResolvedValue(createdLead);

    await createLead(db, input, eventBus, 'user-1');

    expect(leadRepository.createLead).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        duplicate_status: 'flagged',
        duplicate_of_id: 'email-id',
      }),
    );
  });

  it('no match creates lead with duplicate_status=none and duplicate_of_id=null', async () => {
    vi.mocked(leadRepository.createLead).mockResolvedValue(baseLead);

    await createLead(db, input, eventBus, 'user-1');

    expect(leadRepository.createLead).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        duplicate_status: 'none',
        duplicate_of_id: null,
      }),
    );
  });

  it('lead is ALWAYS inserted even when flagged as duplicate', async () => {
    const phoneMatch = { ...baseLead, id: 'existing-id' };
    vi.mocked(leadRepository.findByPhone).mockResolvedValue([phoneMatch]);

    const createdLead = { ...baseLead, duplicate_status: 'flagged' };
    vi.mocked(leadRepository.createLead).mockResolvedValue(createdLead);

    const result = await createLead(db, input, eventBus, 'user-1');

    expect(leadRepository.createLead).toHaveBeenCalled();
    expect(result).toEqual(createdLead);
  });
});
