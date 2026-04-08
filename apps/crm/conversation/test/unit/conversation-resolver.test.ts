import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Knex } from 'knex';

vi.mock('../../src/repositories/conversations.repo.js', () => ({
  findRecent: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../../src/repositories/settings.repo.js', () => ({
  getEffectiveSettings: vi.fn(),
}));

import { resolveConversation } from '../../src/services/conversation-resolver.js';
import * as conversationsRepo from '../../src/repositories/conversations.repo.js';
import { getEffectiveSettings } from '../../src/repositories/settings.repo.js';

const mockDb = {} as Knex;
const baseOpts = {
  leadId: 'lead-1',
  locationId: 'loc-1',
  practiceNumber: '+15551234567',
  leadPhone: '+15559876543',
};

const makeConversation = (overrides = {}) => ({
  id: 'conv-1',
  lead_id: baseOpts.leadId,
  location_id: baseOpts.locationId,
  practice_number: baseOpts.practiceNumber,
  lead_phone: baseOpts.leadPhone,
  status: 'open',
  assigned_to: null,
  escalated: false,
  agent_mode_active: false,
  agent_exchange_count: 0,
  last_message_at: new Date(),
  created_at: new Date(),
  ...overrides,
});

describe('conversation-resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getEffectiveSettings).mockResolvedValue({
      location_id: baseOpts.locationId,
      inactivity_days: 30,
      agent_mode_enabled: false,
      agent_max_exchanges: 3,
      location_phone: null,
      practice_number: null,
      updated_at: new Date(),
    });
  });

  it('finds existing conversation within inactivity window and returns it without creating new', async () => {
    const existing = makeConversation();
    vi.mocked(conversationsRepo.findRecent).mockResolvedValue(existing);

    const result = await resolveConversation(mockDb, baseOpts);

    expect(result).toBe(existing);
    expect(conversationsRepo.create).not.toHaveBeenCalled();
  });

  it('reopens closed conversation within inactivity window (sets status open)', async () => {
    const existing = makeConversation({ status: 'closed' });
    const reopened = makeConversation({ status: 'open' });
    vi.mocked(conversationsRepo.findRecent).mockResolvedValue(existing);
    vi.mocked(conversationsRepo.update).mockResolvedValue(reopened);

    const result = await resolveConversation(mockDb, baseOpts);

    expect(conversationsRepo.update).toHaveBeenCalledWith(mockDb, existing.id, { status: 'open' });
    expect(result).toBe(reopened);
    expect(conversationsRepo.create).not.toHaveBeenCalled();
  });

  it('creates new conversation when no existing conversation found', async () => {
    const created = makeConversation({ id: 'conv-2' });
    vi.mocked(conversationsRepo.findRecent).mockResolvedValue(null);
    vi.mocked(conversationsRepo.create).mockResolvedValue(created);

    const result = await resolveConversation(mockDb, baseOpts);

    expect(conversationsRepo.create).toHaveBeenCalledWith(mockDb, {
      lead_id: baseOpts.leadId,
      location_id: baseOpts.locationId,
      practice_number: baseOpts.practiceNumber,
      lead_phone: baseOpts.leadPhone,
    });
    expect(result).toBe(created);
  });

  it('uses correct (lead_id, practice_number) key for lookup', async () => {
    vi.mocked(conversationsRepo.findRecent).mockResolvedValue(null);
    vi.mocked(conversationsRepo.create).mockResolvedValue(makeConversation());

    await resolveConversation(mockDb, baseOpts);

    expect(conversationsRepo.findRecent).toHaveBeenCalledWith(
      mockDb,
      baseOpts.leadId,
      baseOpts.practiceNumber,
      expect.any(Date),
    );
  });
});
