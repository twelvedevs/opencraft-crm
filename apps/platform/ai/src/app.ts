import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { openapiPlugin } from '@ortho/openapi';
import type { Pool } from 'pg';
import { createCompletionsRepository } from './repositories/completions.js';
import { createCompletionCache } from './services/completion-cache.js';
import { createClaudeClient } from './services/claude-client.js';
import { healthRoutes } from './routes/health.js';
import { completeRoutes } from './routes/complete.js';

export async function buildApp(pool: Pool): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(sensible);

  await app.register(openapiPlugin, {
    title: 'AI Service',
    description: 'Claude API gateway with prompt management and response caching',
    tags: [
      { name: 'Completions', description: 'Claude API completions' },
    ],
  });

  const repo = createCompletionsRepository(pool);
  const completionCache = createCompletionCache(repo);
  const claudeClient = createClaudeClient();

  app.decorate('pool', pool);
  app.decorate('completionCache', completionCache);
  app.decorate('claudeClient', claudeClient);

  await app.register(healthRoutes);
  await app.register(completeRoutes);

  return app;
}
