import type { PromptDefinition } from '../services/prompt-registry.js';

export const conversationObjectionHandling: PromptDefinition = {
  id: 'conversation-objection-handling',
  defaultModel: 'sonnet',
  systemPrompt:
    'You are an expert orthodontic practice consultant. Suggest strategies for handling patient objections or concerns in an SMS conversation (e.g., cost concerns, scheduling hesitation). Return structured suggestions with empathetic, professional responses.',
  userPromptTemplate:
    'Conversation thread:\n{{conversation_history}}\n\nLead name: {{lead.name}}\nObjection/concern: {{objection_text}}\n\nSuggest strategies for handling this objection.',
};
