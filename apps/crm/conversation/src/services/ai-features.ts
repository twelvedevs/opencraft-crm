import type { Knex } from 'knex';
import * as conversationsRepo from '../repositories/conversations.repo.js';
import * as messagesRepo from '../repositories/messages.repo.js';
import { aiClient, leadClient } from '../lib/service-client.js';

export async function getDraftReplies(
  conversationId: string,
  db: Knex,
): Promise<{ drafts: { body: string; label: string }[] }> {
  const conversation = await conversationsRepo.findById(db, conversationId);
  if (!conversation) throw new Error(`Conversation not found: ${conversationId}`);

  const messages = await messagesRepo.listByConversation(db, conversationId, { limit: 10 });
  const lead = await leadClient.get<{ id: string; name: string; current_stage: string; treatment_interest: string }>(
    `/leads/${conversation.lead_id}`,
  );

  const response = await aiClient.post<{ text: string }>('/ai/complete', {
    prompt_id: 'conversation-reply-drafts',
    context: {
      lead_name: lead.name,
      lead_stage: lead.current_stage,
      treatment_interest: lead.treatment_interest,
      recent_messages: messages.map((m) => ({
        direction: m.direction,
        body: m.body,
        created_at: m.created_at,
      })),
    },
  });

  let drafts: { body: string; label: string }[];
  try {
    drafts = JSON.parse(response.text) as { body: string; label: string }[];
  } catch {
    throw Object.assign(new Error('AI service returned unparseable response'), { status: 502 });
  }
  return { drafts };
}

export async function getSummary(
  conversationId: string,
  db: Knex,
): Promise<{ summary: string }> {
  const messages = await messagesRepo.listByConversation(db, conversationId, { limit: 20 });

  const response = await aiClient.post<{ text: string }>('/ai/complete', {
    prompt_id: 'conversation-summary',
    context: {
      recent_messages: messages.map((m) => ({
        direction: m.direction,
        body: m.body,
        created_at: m.created_at,
      })),
    },
  });

  return { summary: response.text };
}

export async function getObjectionStrategies(
  conversationId: string,
  objectionType: string,
  db: Knex,
): Promise<{ strategies: { title: string; body: string }[] }> {
  const response = await aiClient.post<{ text: string }>('/ai/complete', {
    prompt_id: 'conversation-objection-handling',
    context: {
      objection_type: objectionType,
    },
  });

  let strategies: { title: string; body: string }[];
  try {
    strategies = JSON.parse(response.text) as { title: string; body: string }[];
  } catch {
    throw Object.assign(new Error('AI service returned unparseable response'), { status: 502 });
  }
  return { strategies };
}
