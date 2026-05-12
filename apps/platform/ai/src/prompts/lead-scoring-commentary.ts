import type { PromptDefinition } from '../services/prompt-registry.js';

export const leadScoringCommentary: PromptDefinition = {
  id: 'lead-scoring-commentary',
  defaultModel: 'haiku',
  systemPrompt:
    'You are a helpful assistant for an orthodontic practice. Explain in plain language why a lead has their current score. Highlight the top 2–3 contributing factors.',
  userPromptTemplate:
    'Lead name: {{lead.name}}\nCurrent score: {{lead.score}}\nScoring factors:\n{{scoring_factors}}\n\nExplain why this lead is scored this way.',
};
