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

describe('contract: outbound-sender → Messaging Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(conversationsRepo.findById).mockResolvedValue(makeConversation());
    vi.mocked(conversationsRepo.update).mockResolvedValue(makeConversation());
    vi.mocked(messagingClient.post).mockResolvedValue({ message_id: 'msg-ext-1' });
    vi.mocked(messagesRepo.insert).mockResolvedValue({
      id: 'msg-1',
      conversation_id: 'conv-1',
      direction: 'outbound',
      author_id: 'user-1',
      body: 'Hello',
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
  });

  it('calls Messaging Service with required fields { to, from_number, body, dedup_key }', async () => {
    await sendOutbound(mockDb, {
      conversationId: 'conv-1',
      body: 'Hello patient',
      authorId: 'user-1',
    });

    expect(messagingClient.post).toHaveBeenCalledTimes(1);
    const [path, payload] = vi.mocked(messagingClient.post).mock.calls[0];

    expect(path).toBe('/messages/send');

    const body = payload as Record<string, unknown>;
    expect(body).toHaveProperty('to', '+15559876543');
    expect(body).toHaveProperty('from_number', '+15551234567');
    expect(body).toHaveProperty('body', 'Hello patient');
    expect(body).toHaveProperty('dedup_key');
    expect(typeof body.dedup_key).toBe('string');
    expect((body.dedup_key as string).length).toBeGreaterThan(0);
  });

  it('generates unique dedup_key per send', async () => {
    await sendOutbound(mockDb, {
      conversationId: 'conv-1',
      body: 'First',
      authorId: 'user-1',
    });
    await sendOutbound(mockDb, {
      conversationId: 'conv-1',
      body: 'Second',
      authorId: 'user-1',
    });

    const calls = vi.mocked(messagingClient.post).mock.calls;
    const key1 = (calls[0][1] as Record<string, unknown>).dedup_key;
    const key2 = (calls[1][1] as Record<string, unknown>).dedup_key;
    expect(key1).not.toBe(key2);
  });
});
