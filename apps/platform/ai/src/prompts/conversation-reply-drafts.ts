import type { PromptDefinition } from '../services/prompt-registry.js';

export const conversationReplyDrafts: PromptDefinition = {
  id: 'conversation-reply-drafts',
  defaultModel: 'haiku',
  systemPrompt:
    'You are a helpful assistant for an orthodontic practice. Generate 2–3 draft reply options for a coordinator, given the full conversation thread and lead context. Each reply should be concise, friendly, and under 160 characters.',
  userPromptTemplate:
    'Conversation thread:\n{{conversation_history}}\n\nLead name: {{lead.name}}\nTreatment interest: {{lead.treatment_interest}}\nLead stage: {{lead.stage}}\n\nGenerate 2–3 draft reply options.',
};
