import type { PromptDefinition } from '../services/prompt-registry.js';

export const smartReplyDraft: PromptDefinition = {
  id: 'smart-reply-draft',
  defaultModel: 'haiku',
  systemPrompt:
    'You are a helpful assistant for an orthodontic practice. Draft 2–3 short, friendly SMS reply options for the coordinator to choose from. Keep each reply under 160 characters. Match the tone of the conversation.',
  userPromptTemplate:
    'Conversation so far:\n{{conversation_history}}\n\nLead name: {{lead.name}}\nTreatment interest: {{lead.treatment_interest}}\n\nDraft 2–3 reply options.',
};
