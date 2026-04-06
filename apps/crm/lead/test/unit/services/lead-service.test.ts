import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/repositories/lead-repository.js', () => ({
  createLead: vi.fn(),
  findById: vi.fn(),
  updateLead: vi.fn(),
  archiveLead: vi.fn(),
  listLeads: vi.fn(),
  findByPhone: vi.fn(),
  findByEmail: vi.fn(),
  findByAdPlatformLeadId: vi.fn(),
}));

vi.mock('../../../src/repositories/activity-repository.js', () => ({
  insertActivity: vi.fn(),
}));

vi.mock('../../../src/events/publisher.js', () => ({
  publishLeadCreated: vi.fn(),
  publishLeadUpdated: vi.fn(),
  publishLeadArchived: vi.fn(),
}));

import type { Knex } from 'knex';
import type { EventBus } from '@ortho/event-bus';
import {
  normalizePhone,
  createLead,
  getLead,
  updateLead,
  archiveLead,
  listLeads,
} from '../../../src/services/lead-service.js';
import * as leadRepository from '../../../src/repositories/lead-repository.js';
import * as activityRepository from '../../../src/repositories/activity-repository.js';

// Build a mock db whose .transaction() executes the callback with a mock trx.
let mockTrx: Knex;
let db: Knex;

const eventBus = { publish: vi.fn(), stop: vi.fn() } as unknown as EventBus;

const fakeLead = {
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

beforeEach(() => {
  vi.clearAllMocks();
  mockTrx = {} as Knex;
  db = {
    transaction: vi.fn().mockImplementation(async (cb: (trx: Knex) => Promise<unknown>) => cb(mockTrx)),
  } as unknown as Knex;

  vi.mocked(activityRepository.insertActivity).mockResolvedValue('activity-1');
});

describe('normalizePhone', () => {
  it('parses valid US number to E.164', () => {
    expect(normalizePhone('(212) 555-1234')).toBe('+12125551234');
  });

  it('parses 10-digit number to E.164', () => {
    expect(normalizePhone('2125551234')).toBe('+12125551234');
  });

  it('throws on invalid phone number', () => {
    expect(() => normalizePhone('0000000000')).toThrow('invalid phone number');
  });

  it('throws on too-short number', () => {
    expect(() => normalizePhone('123')).toThrow();
  });
});

describe('createLead', () => {
  beforeEach(() => {
    vi.mocked(leadRepository.findByPhone).mockResolvedValue([]);
    vi.mocked(leadRepository.findByEmail).mockResolvedValue([]);
    vi.mocked(leadRepository.findByAdPlatformLeadId).mockResolvedValue(null);
    vi.mocked(leadRepository.createLead).mockResolvedValue(fakeLead);
  });

  it('sets score=0, contact_status=active, duplicate_status=none', async () => {
    await createLead(db, {
      first_name: 'John',
      last_name: 'Doe',
      phone: '2125551234',
      channel: 'website_form',
      location_id: 'loc-1',
    }, eventBus, 'user-1');

    expect(leadRepository.createLead).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      score: 0,
      current_pipeline: 'none',
      contact_status: 'active',
      duplicate_status: 'none',
    }));
  });

  it('normalizes phone before inserting', async () => {
    await createLead(db, {
      first_name: 'John',
      last_name: 'Doe',
      phone: '(212) 555-1234',
      channel: 'website_form',
      location_id: 'loc-1',
    }, eventBus, 'user-1');

    expect(leadRepository.createLead).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      phone: '+12125551234',
    }));
  });

  it('inserts lead and activity in the same transaction', async () => {
    await createLead(db, {
      first_name: 'John',
      last_name: 'Doe',
      phone: '2125551234',
      channel: 'website_form',
      location_id: 'loc-1',
    }, eventBus, 'user-1');

    // Both repository calls must receive the transaction object, not the outer db
    expect(leadRepository.createLead).toHaveBeenCalledWith(mockTrx, expect.anything());
    expect(activityRepository.insertActivity).toHaveBeenCalledWith(mockTrx, expect.anything());
  });

  it('throws on invalid phone', async () => {
    await expect(createLead(db, {
      first_name: 'John',
      last_name: 'Doe',
      phone: '0000000000',
      channel: 'website_form',
      location_id: 'loc-1',
    }, eventBus, 'user-1')).rejects.toThrow('invalid phone number');
  });
});

describe('getLead', () => {
  it('delegates to leadRepository.findById', async () => {
    vi.mocked(leadRepository.findById).mockResolvedValue(fakeLead);
    const result = await getLead(db, fakeLead.id);
    expect(leadRepository.findById).toHaveBeenCalledWith(db, fakeLead.id);
    expect(result).toEqual(fakeLead);
  });
});

describe('updateLead', () => {
  it.each([
    'channel',
    'first_touch_source',
    'referrer_id',
    'ad_platform_lead_id',
  ] as const)('throws when attribution field "%s" is present', async (field) => {
    await expect(updateLead(db, fakeLead.id, { [field]: 'val' }, eventBus)).rejects.toThrow(
      'attribution fields are immutable',
    );
  });

  it('normalizes phone if present', async () => {
    vi.mocked(leadRepository.updateLead).mockResolvedValue({ ...fakeLead, phone: '+12125559876' });

    await updateLead(db, fakeLead.id, { phone: '(212) 555-9876' }, eventBus);

    expect(leadRepository.updateLead).toHaveBeenCalledWith(expect.anything(), fakeLead.id, {
      phone: '+12125559876',
    });
  });

  it('passes non-attribution fields through', async () => {
    vi.mocked(leadRepository.updateLead).mockResolvedValue({ ...fakeLead, first_name: 'Jane' });

    await updateLead(db, fakeLead.id, { first_name: 'Jane' }, eventBus);

    expect(leadRepository.updateLead).toHaveBeenCalledWith(expect.anything(), fakeLead.id, { first_name: 'Jane' });
  });

  it('throws lead not found when repository returns null', async () => {
    vi.mocked(leadRepository.updateLead).mockResolvedValue(null as unknown as typeof fakeLead);

    await expect(updateLead(db, '00000000-0000-0000-0000-000000000000', {}, eventBus))
      .rejects.toThrow('lead not found');
  });

  it('updates lead and inserts activity in the same transaction', async () => {
    vi.mocked(leadRepository.updateLead).mockResolvedValue(fakeLead);

    await updateLead(db, fakeLead.id, { first_name: 'Jane' }, eventBus);

    expect(leadRepository.updateLead).toHaveBeenCalledWith(mockTrx, expect.anything(), expect.anything());
    expect(activityRepository.insertActivity).toHaveBeenCalledWith(mockTrx, expect.anything());
  });
});

describe('archiveLead', () => {
  it('calls leadRepository.archiveLead', async () => {
    vi.mocked(leadRepository.archiveLead).mockResolvedValue({ ...fakeLead, archived_at: '2026-04-06' });

    const result = await archiveLead(db, fakeLead.id, eventBus);

    expect(leadRepository.archiveLead).toHaveBeenCalledWith(expect.anything(), fakeLead.id);
    expect(result.archived_at).toBe('2026-04-06');
  });

  it('archives lead and inserts activity in the same transaction', async () => {
    vi.mocked(leadRepository.archiveLead).mockResolvedValue({ ...fakeLead, archived_at: '2026-04-06' });

    await archiveLead(db, fakeLead.id, eventBus);

    expect(leadRepository.archiveLead).toHaveBeenCalledWith(mockTrx, expect.anything());
    expect(activityRepository.insertActivity).toHaveBeenCalledWith(mockTrx, expect.anything());
  });
});

describe('listLeads', () => {
  it('passes userLocations as locationIds', async () => {
    vi.mocked(leadRepository.listLeads).mockResolvedValue({ leads: [], nextCursor: null });

    await listLeads(db, { sort: 'score', limit: 50 }, ['loc-1', 'loc-2']);

    expect(leadRepository.listLeads).toHaveBeenCalledWith(db, {
      sort: 'score',
      limit: 50,
      locationIds: ['loc-1', 'loc-2'],
    });
  });
});
