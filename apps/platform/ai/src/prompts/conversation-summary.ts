import type { PromptDefinition } from '../services/prompt-registry.js';

export const conversationSummary: PromptDefinition = {
  id: 'conversation-summary',
  defaultModel: 'haiku',
  systemPrompt:
    'You are a helpful assistant for an orthodontic practice. Summarize the conversation thread into a concise 3-sentence briefing. Focus on key decisions, next steps, and patient sentiment.',
  userPromptTemplate:
    'Conversation thread:\n{{conversation_history}}\n\nLead name: {{lead.name}}\n\nSummarize in 3 sentences.',
};
