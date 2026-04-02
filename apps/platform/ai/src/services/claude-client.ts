import Anthropic from '@anthropic-ai/sdk';
import { RateLimitError, APIError, InternalServerError } from '@anthropic-ai/sdk/error';
import { trace } from '@opentelemetry/api';

const MODEL_MAP: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
};

export function resolveModel(alias: string): string {
  return MODEL_MAP[alias] ?? alias;
}

export interface ClaudeCompleteParams {
  promptId: string;
  systemPrompt: string;
  userPrompt: string;
  model: string;
  maxTokens: number;
}

export interface ClaudeClient {
  complete(params: ClaudeCompleteParams): Promise<string>;
}

export function createClaudeClient(): ClaudeClient {
  const client = new Anthropic();
  const tracer = trace.getTracer('ai-service');

  return {
    async complete(params: ClaudeCompleteParams): Promise<string> {
      const fullModel = resolveModel(params.model);

      return tracer.startActiveSpan('claude.complete', async (span) => {
        span.setAttribute('prompt_id', params.promptId);
        span.setAttribute('cached', false);

        try {
          const response = await client.messages.create({
            model: fullModel,
            max_tokens: params.maxTokens,
            system: params.systemPrompt,
            messages: [{ role: 'user', content: params.userPrompt }],
          });

          const block = response.content[0];
          if (block.type === 'text') {
            return block.text;
          }
          return '';
        } catch (err) {
          if (err instanceof RateLimitError || err instanceof InternalServerError) {
            const error = new Error('Claude API unavailable') as Error & { statusCode: number };
            error.statusCode = 503;
            throw error;
          }
          if (err instanceof APIError) {
            const error = new Error('Claude API unavailable') as Error & { statusCode: number };
            error.statusCode = 503;
            throw error;
          }
          throw err;
        } finally {
          span.end();
        }
      });
    },
  };
}
