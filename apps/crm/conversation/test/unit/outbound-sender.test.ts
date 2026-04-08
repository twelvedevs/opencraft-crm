import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Knex } from 'knex';

vi.mock('../../src/repositories/conversations.repo.js', () => ({
  findById: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../../src/repositories/messages.repo.js', () => ({
  insert: vi.fn(),
}));

vi.mock('../../src/lib/service-client.js', () => ({
  messagingClient: {
    post: vi.fn(),
  },
}));

import { sendOutbound } from '../../src/services/outbound-sender.js';
import * as conversationsRepo from '../../src/repositories/conversations.repo.js';
import * as messagesRepo from '../../src/repositories/messages.repo.js';
import { messagingClient } from '../../src/lib/service-client.js';

const mockDb = {} as Knex;

const makeConversation = (overrides = {}) => ({
  id: 'conv-1',
  lead_id: 'lead-1',
  location_id: 'loc-1',
  practice_number: '+15551234567',
  lead_phone: '+15559876543',
  status: 'open',
  assigned_to: null,
  escalated: false,
  agent_mode_active: false,
  agent_exchange_count: 0,
  last_message_at: new Date(),
  created_at: new Date(),
  ...overrides,
});

describe('outbound-sender', () => {
  const baseOpts = {
    conversationId: 'conv-1',
    body: 'Hello there',
    authorId: 'user-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(messagingClient.post).mockResolvedValue({ message_id: 'msg-ext-1' });
    vi.mocked(messagesRepo.insert).mockResolvedValue({
      id: 'msg-1',
      conversation_id: 'conv-1',
      direction: 'outbound',
      author_id: 'user-1',
      body: 'Hello there',
      media_urls: null,
      message_type: 'normal',
      status: 'queued',
      is_automated: false,
      is_agent: false,
      messaging_message_id: 'msg-ext-1',
      sent_at: null,
      delivered_at: null,
      received_at: null,
      created_at: new Date(),
    });
    vi.mocked(conversationsRepo.update).mockResolvedValue(makeConversation());
  });

  it('sets agent_mode_active=false when sending while agent mode is active', async () => {
    vi.mocked(conversationsRepo.findById).mockResolvedValue(
      makeConversation({ agent_mode_active: true }),
    );

    await sendOutbound(mockDb, baseOpts);

    expect(conversationsRepo.update).toHaveBeenCalledWith(
      mockDb,
      'conv-1',
      expect.objectContaining({ agent_mode_active: false }),
    );
  });

  it('does NOT disable agent mode when agent_mode_active is already false', async () => {
    vi.mocked(conversationsRepo.findById).mockResolvedValue(
      makeConversation({ agent_mode_active: false }),
    );

    await sendOutbound(mockDb, baseOpts);

    // update is called only for last_message_at, not for agent_mode_active
    const updateCalls = vi.mocked(conversationsRepo.update).mock.calls;
    const agentModeCall = updateCalls.find(
      (call) => (call[2] as Record<string, unknown>).agent_mode_active === false,
    );
    expect(agentModeCall).toBeUndefined();
  });

  it('generates a unique dedup_key on each call (two calls produce different keys)', async () => {
    vi.mocked(conversationsRepo.findById).mockResolvedValue(makeConversation());

    await sendOutbound(mockDb, baseOpts);
    await sendOutbound(mockDb, baseOpts);

    const postCalls = vi.mocked(messagingClient.post).mock.calls;
    const key1 = (postCalls[0][1] as Record<string, unknown>).dedup_key;
    const key2 = (postCalls[1][1] as Record<string, unknown>).dedup_key;
    expect(key1).not.toBe(key2);
    expect(typeof key1).toBe('string');
    expect(typeof key2).toBe('string');
  });
});
