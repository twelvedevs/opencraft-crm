export interface PromptDefinition {
  id: string;
  defaultModel: 'haiku' | 'sonnet';
  systemPrompt: string;
  userPromptTemplate: string;
  maxTokens?: number;
  structured?: boolean;
}

import { smartReplyDraft } from '../prompts/smart-reply-draft.js';
import { sequencePersonalization } from '../prompts/sequence-personalization.js';
import { objectionHandling } from '../prompts/objection-handling.js';
import { conversationSummary } from '../prompts/conversation-summary.js';
import { followUpTiming } from '../prompts/follow-up-timing.js';
import { leadScoringCommentary } from '../prompts/lead-scoring-commentary.js';
import { conversationReplyDrafts } from '../prompts/conversation-reply-drafts.js';
import { conversationObjectionHandling } from '../prompts/conversation-objection-handling.js';
import { conversationAgentReply } from '../prompts/conversation-agent-reply.js';

const allPrompts: PromptDefinition[] = [
  smartReplyDraft,
  sequencePersonalization,
  objectionHandling,
  conversationSummary,
  followUpTiming,
  leadScoringCommentary,
  conversationReplyDrafts,
  conversationObjectionHandling,
  conversationAgentReply,
];

export const promptRegistry: Map<string, PromptDefinition> = new Map(
  allPrompts.map((p) => [p.id, p])
);

export function getPrompt(id: string): PromptDefinition | null {
  return promptRegistry.get(id) ?? null;
}
