import type { PromptDefinition } from '../services/prompt-registry.js';

export const sequencePersonalization: PromptDefinition = {
  id: 'sequence-personalization',
  defaultModel: 'haiku',
  systemPrompt:
    'You are a helpful assistant for an orthodontic practice. Personalize the given template message for the specific lead. Keep the same intent, length, and tone but make it feel personal.',
  userPromptTemplate:
    'Template message:\n{{template_text}}\n\nLead name: {{lead.name}}\nTreatment interest: {{lead.treatment_interest}}\nLocation: {{lead.location}}\n\nPersonalize this message for the lead.',
};
