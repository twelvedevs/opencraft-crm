import type { PromptDefinition } from '../services/prompt-registry.js';

export const objectionHandling: PromptDefinition = {
  id: 'objection-handling',
  defaultModel: 'sonnet',
  systemPrompt:
    'You are an expert orthodontic practice consultant. When a coordinator flags a patient objection, suggest 2–3 response strategies. Be empathetic, professional, and specific to orthodontic concerns (cost, duration, pain, aesthetics).',
  userPromptTemplate:
    'Objection raised: {{objection_text}}\n\nLead name: {{lead.name}}\nTreatment interest: {{lead.treatment_interest}}\nConversation context:\n{{conversation_history}}\n\nSuggest response strategies.',
};
