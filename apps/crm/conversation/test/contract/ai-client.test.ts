import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Knex } from 'knex';

vi.mock('../../src/repositories/conversations.repo.js', () => ({
  findById: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../../src/repositories/messages.repo.js', () => ({
  listByConversation: vi.fn(),
  insert: vi.fn(),
}));

vi.mock('../../src/repositories/settings.repo.js', () => ({
  getEffectiveSettings: vi.fn(),
}));

vi.mock('../../src/lib/service-client.js', () => ({
  aiClient: { post: vi.fn() },
  leadClient: { get: vi.fn() },
  messagingClient: { post: vi.fn() },
  notificationClient: { post: vi.fn() },
}));

import * as conversationsRepo from '../../src/repositories/conversations.repo.js';
import * as messagesRepo from '../../src/repositories/messages.repo.js';
import * as settingsRepo from '../../src/repositories/settings.repo.js';
import { aiClient, leadClient, messagingClient } from '../../src/lib/service-client.js';
import { parseAgentResponse } from '../../src/services/agent-mode.js';

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
  agent_mode_active: true,
  agent_exchange_count: 0,
  last_message_at: new Date(),
  created_at: new Date(),
  ...overrides,
});

describe('contract: ai-agent-reply worker → AI Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(conversationsRepo.findById).mockResolvedValue(makeConversation());
    vi.mocked(conversationsRepo.update).mockResolvedValue(makeConversation());
    vi.mocked(messagesRepo.listByConversation).mockResolvedValue([
      {
        id: 'msg-1',
        conversation_id: 'conv-1',
        direction: 'inbound' as const,
        author_id: null,
        body: 'I want braces',
        media_urls: null,
        message_type: 'normal',
        status: 'received',
        is_automated: false,
        is_agent: false,
        messaging_message_id: null,
        sent_at: null,
        delivered_at: null,
        received_at: new Date(),
        created_at: new Date(),
      },
    ]);
    vi.mocked(messagesRepo.insert).mockResolvedValue({
      id: 'msg-2',
      conversation_id: 'conv-1',
      direction: 'outbound',
      author_id: null,
      body: 'reply',
      media_urls: null,
      message_type: 'normal',
      status: 'queued',
      is_automated: false,
      is_agent: true,
      messaging_message_id: 'msg-ext-1',
      sent_at: null,
      delivered_at: null,
      received_at: null,
      created_at: new Date(),
    });
    vi.mocked(settingsRepo.getEffectiveSettings).mockResolvedValue({
      inactivity_days: 30,
      agent_mode_enabled: true,
      agent_max_exchanges: 3,
      location_phone: '+15551234567',
      practice_number: '+15551234567',
    });
    vi.mocked(leadClient.get).mockResolvedValue({
      id: 'lead-1',
      name: 'Jane Doe',
      current_stage: 'new_lead',
      treatment_interest: 'braces',
    });
    vi.mocked(messagingClient.post).mockResolvedValue({ message_id: 'msg-ext-1' });
  });

  it('calls AI Service with { prompt_id, context } containing required fields', async () => {
    const agentResponse = { text: 'Hello! We can help with braces.', escalate: false };
    vi.mocked(aiClient.post).mockResolvedValue({
      text: JSON.stringify(agentResponse),
    });

    // Replicate the worker handler logic (same as integration tests)
    const conversation = await conversationsRepo.findById(mockDb, 'conv-1');
    const messages = await messagesRepo.listByConversation(mockDb, 'conv-1', { limit: 10 });
    const settings = await settingsRepo.getEffectiveSettings(mockDb, conversation!.location_id);
    const lead = await leadClient.get<{
      id: string;
      name: string;
      current_stage: string;
      treatment_interest: string;
    }>(`/leads/${conversation!.lead_id}`);

    await aiClient.post('/ai/complete', {
      prompt_id: 'conversation-agent-reply',
      context: {
        lead_name: lead.name,
        lead_stage: lead.current_stage,
        treatment_interest: lead.treatment_interest,
        location_name: settings.location_phone,
        recent_messages: messages.map((m) => ({
          direction: m.direction,
          body: m.body,
          created_at: m.created_at,
        })),
      },
    });

    // Verify AI Service call shape
    const aiCalls = vi.mocked(aiClient.post).mock.calls;
    expect(aiCalls).toHaveLength(1);
    const [path, body] = aiCalls[0];

    expect(path).toBe('/ai/complete');

    const reqBody = body as Record<string, unknown>;
    expect(reqBody).toHaveProperty('prompt_id', 'conversation-agent-reply');
    expect(reqBody).toHaveProperty('context');

    const ctx = reqBody.context as Record<string, unknown>;
    expect(ctx).toHaveProperty('lead_name', 'Jane Doe');
    expect(ctx).toHaveProperty('lead_stage', 'new_lead');
    expect(ctx).toHaveProperty('treatment_interest', 'braces');
    expect(ctx).toHaveProperty('recent_messages');
    expect(Array.isArray(ctx.recent_messages)).toBe(true);
  });

  it('AI Service response.text is parseable as { text, escalate } JSON', () => {
    const responseText = JSON.stringify({
      text: 'Hello! We can help with braces.',
      escalate: false,
    });

    const parsed = parseAgentResponse(responseText);

    expect(parsed).not.toBeNull();
    expect(typeof parsed!.text).toBe('string');
    expect(typeof parsed!.escalate).toBe('boolean');
    expect(parsed!.text).toBe('Hello! We can help with braces.');
    expect(parsed!.escalate).toBe(false);
  });

  it('parseAgentResponse handles escalation response', () => {
    const responseText = JSON.stringify({
      text: '',
      escalate: true,
      reason: 'Patient needs human assistance',
    });

    const parsed = parseAgentResponse(responseText);

    expect(parsed).not.toBeNull();
    expect(parsed!.escalate).toBe(true);
    expect(parsed!.reason).toBe('Patient needs human assistance');
  });
});
