import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { getPrompt } from '../services/prompt-registry.js';
import { injectContext } from '../services/context-injector.js';
import { computeCacheKey } from '../services/completion-cache.js';
import { createLogger } from '@ortho/logger';

const logger = createLogger('ai-complete-route');

const CompleteBodySchema = Type.Object({
  prompt_id: Type.String({ minLength: 1 }),
  context: Type.Unknown(),
  model: Type.Optional(Type.Union([Type.Literal('haiku'), Type.Literal('sonnet')])),
});

export async function completeRoutes(app: FastifyInstance): Promise<void> {
  app.post('/ai/complete', {
    schema: {
      tags: ['Completions'],
      summary: 'Request Claude completion',
      body: CompleteBodySchema,
    } as object,
  }, async (req, reply) => {
    const { prompt_id, context, model: requestModel } = req.body as {
      prompt_id: string;
      context: unknown;
      model?: 'haiku' | 'sonnet';
    };

    // Manual runtime check: context must be a plain object or array
    if (
      context === null ||
      context === undefined ||
      typeof context === 'string' ||
      typeof context === 'number' ||
      typeof context === 'boolean'
    ) {
      return reply.status(400).send({ error: 'context must be an object or array' });
    }

    // Lookup prompt
    const prompt = getPrompt(prompt_id);
    if (!prompt) {
      return reply.status(404).send({ error: 'Prompt not found' });
    }

    // Resolve model: request override > prompt defaultModel
    const model = requestModel ?? prompt.defaultModel;

    // Check cache
    const cacheKey = computeCacheKey(prompt_id, model, context);
    const cached = await app.completionCache.get(cacheKey);
    if (cached) {
      return reply.send({
        text: cached.text,
        model,
        prompt_id,
        cached: true,
        structured: prompt.structured ?? false,
      });
    }

    // Inject context into prompt templates
    const typedContext = context as Record<string, unknown> | unknown[];
    const systemPrompt = injectContext(prompt.systemPrompt, typedContext);
    const userPrompt = injectContext(prompt.userPromptTemplate, typedContext);

    // Call Claude
    try {
      const text = await app.claudeClient.complete({
        promptId: prompt_id,
        systemPrompt,
        userPrompt,
        model,
        maxTokens: prompt.maxTokens ?? 500,
      });

      // Write to cache
      app.completionCache.set(cacheKey, text, prompt_id, model);

      return reply.send({
        text,
        model,
        prompt_id,
        cached: false,
        structured: prompt.structured ?? false,
      });
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      if (error.statusCode === 503) {
        return reply.status(503).send({ error: 'Claude API unavailable' });
      }
      logger.error({ err }, 'Unexpected error in /ai/complete');
      throw err;
    }
  });
}
