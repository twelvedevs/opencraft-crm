import type { PromptDefinition } from '../services/prompt-registry.js';

export const followUpTiming: PromptDefinition = {
  id: 'follow-up-timing',
  defaultModel: 'haiku',
  systemPrompt:
    'You are a helpful assistant for an orthodontic practice. Based on the lead behavior and conversation history, suggest the optimal next follow-up time and channel (SMS, call, email). Be specific with timing.',
  userPromptTemplate:
    'Lead name: {{lead.name}}\nLast contact: {{lead.last_contact}}\nLead stage: {{lead.stage}}\nResponse pattern: {{lead.response_pattern}}\n\nSuggest optimal follow-up timing and channel.',
};
