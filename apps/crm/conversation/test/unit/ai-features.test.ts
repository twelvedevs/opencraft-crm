import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../../src/repositories/conversations.repo.js', () => ({
  findById: vi.fn(),
}));
vi.mock('../../src/repositories/messages.repo.js', () => ({
  listByConversation: vi.fn(),
}));
vi.mock('../../src/lib/service-client.js', () => ({
  aiClient: { post: vi.fn() },
  leadClient: { get: vi.fn() },
}));

import * as conversationsRepo from '../../src/repositories/conversations.repo.js';
import * as messagesRepo from '../../src/repositories/messages.repo.js';
import { aiClient, leadClient } from '../../src/lib/service-client.js';
import { getDraftReplies, getSummary, getObjectionStrategies } from '../../src/services/ai-features.js';

const mockConversation = {
  id: 'conv-001',
  lead_id: 'lead-001',
  location_id: 'loc-001',
  practice_number: '+15551234567',
  lead_phone: '+15559876543',
  status: 'open',
  assigned_to: null,
  escalated: false,
  agent_mode_active: false,
  agent_exchange_count: 0,
  last_message_at: new Date(),
  created_at: new Date(),
};

const mockMessages = [
  { direction: 'inbound', body: 'Hi!', created_at: new Date() },
];

const mockLead = {
  id: 'lead-001',
  name: 'Jane Doe',
  current_stage: 'new_lead',
  treatment_interest: 'braces',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(conversationsRepo.findById).mockResolvedValue(mockConversation as never);
  vi.mocked(messagesRepo.listByConversation).mockResolvedValue(mockMessages as never);
  vi.mocked(leadClient.get).mockResolvedValue(mockLead as never);
});

describe('getDraftReplies', () => {
  it('returns parsed drafts from AI service', async () => {
    const drafts = [{ body: 'Thanks for reaching out!', label: 'Friendly' }];
    vi.mocked(aiClient.post).mockResolvedValue({ text: JSON.stringify(drafts) });

    const result = await getDraftReplies('conv-001', {} as never);
    expect(result).toEqual({ drafts });
    expect(aiClient.post).toHaveBeenCalledWith('/ai/complete', expect.objectContaining({
      prompt_id: 'conversation-reply-drafts',
    }));
  });

  it('throws when conversation not found', async () => {
    vi.mocked(conversationsRepo.findById).mockResolvedValue(null);
    await expect(getDraftReplies('missing', {} as never)).rejects.toThrow('Conversation not found');
  });

  it('throws 502 when AI returns non-JSON', async () => {
    vi.mocked(aiClient.post).mockResolvedValue({ text: 'This is not JSON' });
    const err = await getDraftReplies('conv-001', {} as never).catch((e) => e as Error & { status?: number });
    expect(err.message).toMatch(/unparseable/);
    expect((err as { status?: number }).status).toBe(502);
  });

  it('throws 502 when AI returns empty string', async () => {
    vi.mocked(aiClient.post).mockResolvedValue({ text: '' });
    const err = await getDraftReplies('conv-001', {} as never).catch((e) => e);
    expect((err as { status?: number }).status).toBe(502);
  });
});

describe('getSummary', () => {
  it('returns summary text from AI service', async () => {
    vi.mocked(aiClient.post).mockResolvedValue({ text: 'Patient is interested in Invisalign.' });

    const result = await getSummary('conv-001', {} as never);
    expect(result).toEqual({ summary: 'Patient is interested in Invisalign.' });
    expect(aiClient.post).toHaveBeenCalledWith('/ai/complete', expect.objectContaining({
      prompt_id: 'conversation-summary',
    }));
  });
});

describe('getObjectionStrategies', () => {
  it('returns parsed strategies from AI service', async () => {
    const strategies = [{ title: 'Cost concern', body: 'Explain financing options.' }];
    vi.mocked(aiClient.post).mockResolvedValue({ text: JSON.stringify(strategies) });

    const result = await getObjectionStrategies('conv-001', 'cost', {} as never);
    expect(result).toEqual({ strategies });
    expect(aiClient.post).toHaveBeenCalledWith('/ai/complete', expect.objectContaining({
      prompt_id: 'conversation-objection-handling',
      context: expect.objectContaining({ objection_type: 'cost' }),
    }));
  });

  it('throws 502 when AI returns non-JSON', async () => {
    vi.mocked(aiClient.post).mockResolvedValue({ text: 'not json' });
    const err = await getObjectionStrategies('conv-001', 'cost', {} as never).catch((e) => e);
    expect((err as { status?: number }).status).toBe(502);
  });
});
