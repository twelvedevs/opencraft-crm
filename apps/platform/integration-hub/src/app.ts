import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { openapiPlugin } from '@ortho/openapi';
import { jwtAuthPlugin, type JwtAuthOptions } from './plugins/jwt-auth.js';
import { oauthRoutes, type OAuthRoutesOpts } from './routes/oauth.js';
import { accountsRoutes, type AccountsRoutesOpts } from './routes/accounts.js';
import { backfillRoutes, type BackfillRoutesOpts } from './routes/backfill.js';
import { webhookRoutes, type WebhookRoutesOpts } from './routes/webhooks.js';
import { createLogger } from '@ortho/logger';
import { requestLoggingPlugin } from '@ortho/fastify-logger';

export interface BuildAppOptions {
  jwt: JwtAuthOptions;
  oauth: OAuthRoutesOpts;
  accounts: AccountsRoutesOpts;
  backfill: BackfillRoutesOpts;
  webhooks: WebhookRoutesOpts;
  logLevel?: string;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const log = createLogger('platform-integration-hub');
  const fastify = Fastify({
    loggerInstance: log as unknown as FastifyBaseLogger,
    disableRequestLogging: true,
  });

  await fastify.register(sensible);
  await fastify.register(requestLoggingPlugin, { logger: log });
  await fastify.register(openapiPlugin, {
    title: 'Integration Hub',
    description: 'External API connectors — Google Ads and Meta Marketing APIs',
    tags: [
      { name: 'Accounts', description: 'Integration account management' },
      { name: 'OAuth', description: 'OAuth authorization flows' },
      { name: 'Backfill', description: 'Historical data backfill jobs' },
      { name: 'Webhooks', description: 'Ad platform webhook receivers' },
    ],
  });
  await fastify.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  // Health check (no auth)
  fastify.get('/health', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async () => ({ status: 'ok' }));

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
