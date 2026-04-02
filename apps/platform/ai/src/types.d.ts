import type { Pool } from 'pg';
import type { CompletionCache } from './services/completion-cache.js';
import type { ClaudeClient } from './services/claude-client.js';

declare module 'fastify' {
  interface FastifyInstance {
    pool: Pool;
    completionCache: CompletionCache;
    claudeClient: ClaudeClient;
  }
}
