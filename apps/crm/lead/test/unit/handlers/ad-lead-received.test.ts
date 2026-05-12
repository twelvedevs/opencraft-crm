import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/repositories/lead-repository.js', () => ({
  findByAdPlatformLeadId: vi.fn(),
  findByPhone: vi.fn(),
  findByEmail: vi.fn(),
  createLead: vi.fn(),
}));

vi.mock('../../../src/repositories/activity-repository.js', () => ({
  insertActivity: vi.fn(),
}));

vi.mock('../../../src/events/publisher.js', () => ({
  publishLeadCreated: vi.fn(),
}));

import type { Knex } from 'knex';
import type { EventBus, OrthoEvent } from '@ortho/event-bus';
import { handleAdLeadReceived } from '../../../src/workers/handlers/ad-lead-received.js';
import * as leadRepository from '../../../src/repositories/lead-repository.js';
import * as activityRepository from '../../../src/repositories/activity-repository.js';
import { publishLeadCreated } from '../../../src/events/publisher.js';

const makeLead = (overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-1111-1111-111111111111',
  location_id: 'loc-1',
  first_name: 'John',
  last_name: 'Doe',
  phone: '+15551234567',
  email: 'john@example.com',
  treatment_interest: null,
  date_of_birth: null,
  channel: 'google_ads',
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
  ad_platform_lead_id: 'ext-123',
  created_by_location: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

const makeEvent = (overrides: Record<string, unknown> = {}): OrthoEvent => ({
  event_id: 'evt-001',
  event_type: 'ad_lead.received',
  entity_type: 'lead',
  entity_id: '',
  timestamp: new Date().toISOString(),
  payload: {
    external_lead_id: 'ext-123',
    location_id: 'loc-1',
    platform: 'Google Ads',
    fields: {
      full_name: 'John Doe',
      phone_number: '(212) 555-1234',
      email: 'john@example.com',
    },
    ...overrides,
  },
});

let mockTrx: Knex.Transaction;
let db: Knex;
const bus = { publish: vi.fn(), stop: vi.fn() } as unknown as EventBus;

const createMockTrx = () => {
  const trx = vi.fn() as unknown as Knex.Transaction;
  (trx as unknown as Record<string, unknown>).raw = vi.fn().mockResolvedValue(undefined);
  (trx as unknown as Record<string, unknown>).fn = { now: () => 'now()' };
  return trx;
};

const createMockDb = () => {
  mockTrx = createMockTrx();
  const trxFn = vi.fn().mockImplementation(async (cb: (trx: Knex.Transaction) => Promise<unknown>) => {
    return cb(mockTrx);
  });
  return { transaction: trxFn } as unknown as Knex;
};

beforeEach(() => {
  vi.clearAllMocks();
  db = createMockDb();

  vi.mocked(leadRepository.findByAdPlatformLeadId).mockResolvedValue(null);
  vi.mocked(leadRepository.findByPhone).mockResolvedValue([]);
  vi.mocked(leadRepository.findByEmail).mockResolvedValue([]);
  vi.mocked(leadRepository.createLead).mockResolvedValue(makeLead());
  vi.mocked(activityRepository.insertActivity).mockResolvedValue('activity-1');
  vi.mocked(publishLeadCreated).mockResolvedValue(undefined);
});

describe('handleAdLeadReceived', () => {
  it('returns early without insert when ad_platform_lead_id already exists', async () => {
    vi.mocked(leadRepository.findByAdPlatformLeadId).mockResolvedValue(makeLead());

    await handleAdLeadReceived(makeEvent(), db, bus);

    expect(leadRepository.createLead).not.toHaveBeenCalled();
    expect(activityRepository.insertActivity).not.toHaveBeenCalled();
    expect(publishLeadCreated).not.toHaveBeenCalled();
  });

  it('returns early without insert when phone is invalid', async () => {
    const event = makeEvent({ fields: { full_name: 'John Doe', phone_number: '123', email: '' } });

    await handleAdLeadReceived(event, db, bus);

    expect(leadRepository.createLead).not.toHaveBeenCalled();
    expect(publishLeadCreated).not.toHaveBeenCalled();
  });

  it('creates lead, inserts activity, and publishes event for valid payload', async () => {
    const lead = makeLead({ id: 'new-lead-id' });
    vi.mocked(leadRepository.createLead).mockResolvedValue(lead);

    await handleAdLeadReceived(makeEvent(), db, bus);

    expect(leadRepository.createLead).toHaveBeenCalledWith(
      mockTrx,
      expect.objectContaining({
        first_name: 'John',
        last_name: 'Doe',
        phone: '+12125551234',
        email: 'john@example.com',
        channel: 'google_ads',
        location_id: 'loc-1',
        ad_platform_lead_id: 'ext-123',
        contact_status: 'active',
        current_pipeline: 'none',
        score: 0,
        duplicate_status: 'none',
        duplicate_of_id: null,
      }),
    );

    expect(activityRepository.insertActivity).toHaveBeenCalledWith(
      mockTrx,
      expect.objectContaining({
        lead_id: 'new-lead-id',
        event_type: 'lead.created',
        actor_type: 'system',
      }),
    );

    expect(publishLeadCreated).toHaveBeenCalledWith(bus, {
      lead_id: 'new-lead-id',
      location_id: 'loc-1',
      channel: 'google_ads',
      current_pipeline: 'none',
      current_stage: null,
    });
  });

  it('maps google platform to google_ads channel', async () => {
    const event = makeEvent({ platform: 'Google Ads' });
    vi.mocked(leadRepository.createLead).mockResolvedValue(makeLead());

    await handleAdLeadReceived(event, db, bus);

    expect(leadRepository.createLead).toHaveBeenCalledWith(
      mockTrx,
      expect.objectContaining({ channel: 'google_ads' }),
    );
  });

  it('maps facebook platform to facebook_ads channel', async () => {
    const event = makeEvent({ platform: 'Facebook Lead Ads' });
    vi.mocked(leadRepository.createLead).mockResolvedValue(makeLead());

    await handleAdLeadReceived(event, db, bus);

    expect(leadRepository.createLead).toHaveBeenCalledWith(
      mockTrx,
      expect.objectContaining({ channel: 'facebook_ads' }),
    );
  });

  it('maps meta platform to facebook_ads channel', async () => {
    const event = makeEvent({ platform: 'Meta Marketing' });
    vi.mocked(leadRepository.createLead).mockResolvedValue(makeLead());

    await handleAdLeadReceived(event, db, bus);

    expect(leadRepository.createLead).toHaveBeenCalledWith(
      mockTrx,
      expect.objectContaining({ channel: 'facebook_ads' }),
    );
  });

  it('sets duplicate_status=flagged when phone match found', async () => {
    const existingLead = makeLead({ id: 'older-lead', created_at: '2025-01-01T00:00:00Z' });
    vi.mocked(leadRepository.findByPhone).mockResolvedValue([existingLead]);
    vi.mocked(leadRepository.createLead).mockResolvedValue(makeLead());

    await handleAdLeadReceived(makeEvent(), db, bus);

    expect(leadRepository.createLead).toHaveBeenCalledWith(
      mockTrx,
      expect.objectContaining({
        duplicate_status: 'flagged',
        duplicate_of_id: 'older-lead',
      }),
    );
  });

  it('publishLeadCreated called with correct entity_type and entity_id', async () => {
    const lead = makeLead({ id: 'lead-xyz' });
    vi.mocked(leadRepository.createLead).mockResolvedValue(lead);

    await handleAdLeadReceived(makeEvent(), db, bus);

    expect(publishLeadCreated).toHaveBeenCalledWith(
      bus,
      expect.objectContaining({ lead_id: 'lead-xyz' }),
    );
  });
});
