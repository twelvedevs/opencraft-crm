import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { jwtAuthPlugin, type JwtAuthOptions } from './plugins/jwt-auth.js';
import { oauthRoutes, type OAuthRoutesOpts } from './routes/oauth.js';
import { accountsRoutes, type AccountsRoutesOpts } from './routes/accounts.js';
import { backfillRoutes, type BackfillRoutesOpts } from './routes/backfill.js';
import { webhookRoutes, type WebhookRoutesOpts } from './routes/webhooks.js';

export interface BuildAppOptions {
  jwt: JwtAuthOptions;
  oauth: OAuthRoutesOpts;
  accounts: AccountsRoutesOpts;
  backfill: BackfillRoutesOpts;
  webhooks: WebhookRoutesOpts;
  logLevel?: string;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: { level: opts.logLevel ?? 'info' },
  });

  await fastify.register(sensible);
  await fastify.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  // Health check (no auth)
  fastify.get('/health', async () => ({ status: 'ok' }));

  // Webhook routes — NO JWT auth (must be registered before the JWT-scoped routes)
  await fastify.register(
    async (scope) => {
      await webhookRoutes(scope, opts.webhooks);
    },
  );

  // JWT-protected routes
  await fastify.register(
    async (scope) => {
      await scope.register(jwtAuthPlugin, opts.jwt);
      await oauthRoutes(scope, opts.oauth);
      await accountsRoutes(scope, opts.accounts);
      await backfillRoutes(scope, opts.backfill);
    },
  );

  return fastify;
}
