import pg from 'pg';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createLogger } from '@ortho/logger';
import { env } from './env.js';
import { buildApp } from './app.js';
import { createBus } from './services/event-bus.js';
import { createSecretsProvider } from './services/secrets-provider.js';
import { ConnectorRegistry } from './connectors/registry.js';
import { GoogleAdsConnector } from './connectors/google-ads.js';
import { MetaConnector } from './connectors/meta.js';
import { createPollAdSpendWorker } from './jobs/poll-ad-spend.js';
import { createRefreshTokenWorker } from './jobs/refresh-token.js';
import { createProcessLeadWebhookWorker } from './jobs/process-lead-webhook.js';
import { createBackfillAdSpendWorker } from './jobs/backfill-ad-spend.js';
import { upsertPollJob } from './services/poll-scheduler.js';
import { scheduleTokenRefresh } from './jobs/refresh-token.js';
import * as accountsRepo from './repositories/accounts.js';

const log = createLogger('integration-hub');

// --- Secrets provider ---
const secretsProvider = createSecretsProvider(env.SECRETS_PROVIDER);

// --- Encryption key ---
let encryptionKey: Buffer;
if (env.INTEGRATION_HUB_ENCRYPTION_KEY) {
  encryptionKey = Buffer.from(env.INTEGRATION_HUB_ENCRYPTION_KEY, 'base64');
} else {
  const keyStr = await secretsProvider.getSecret('INTEGRATION_HUB_ENCRYPTION_KEY');
  encryptionKey = Buffer.from(keyStr, 'base64');
}

// --- Database pool ---
const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

// --- Redis ---
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const redisConnection = { host: redis.options.host ?? 'localhost', port: redis.options.port ?? 6379 };

// --- BullMQ Queues ---
const pollQueue = new Queue('integration-hub:poll-ad-spend', { connection: redisConnection });
const refreshQueue = new Queue('integration-hub:refresh-token', { connection: redisConnection });
const leadWebhookQueue = new Queue('integration-hub:process-lead-webhook', { connection: redisConnection });
const backfillQueue = new Queue('integration-hub:backfill-ad-spend', { connection: redisConnection });

// --- Event bus (publish-only) ---
const bus = createBus();

// --- Connectors ---
ConnectorRegistry.set('google_ads', new GoogleAdsConnector({
  clientId: env.GOOGLE_ADS_CLIENT_ID,
  clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
  developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
  redirectUri: env.GOOGLE_ADS_REDIRECT_URI,
  webhookVerifyToken: env.GOOGLE_ADS_WEBHOOK_VERIFY_TOKEN,
  encryptionKey,
}));

ConnectorRegistry.set('facebook_ads', new MetaConnector({
  appId: env.META_APP_ID,
  appSecret: env.META_APP_SECRET,
  redirectUri: env.META_REDIRECT_URI,
  webhookVerifyToken: env.META_WEBHOOK_VERIFY_TOKEN,
  encryptionKey,
}));

// --- BullMQ Workers ---
const workers = [
  createPollAdSpendWorker(pool, ConnectorRegistry, bus, redisConnection, log),
  createRefreshTokenWorker(pool, ConnectorRegistry, encryptionKey, refreshQueue, redisConnection, log),
  createProcessLeadWebhookWorker(pool, bus, redisConnection, log),
  createBackfillAdSpendWorker(pool, ConnectorRegistry, bus, redisConnection, log),
];

// --- Fastify app ---
const app = await buildApp({
  jwt: {
    mode: env.JWT_MODE,
    publicKey: env.IDENTITY_SERVICE_PUBLIC_KEY,
    jwksUrl: env.IDENTITY_SERVICE_JWKS_URL,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  },
  oauth: {
    pool,
    pollQueue,
    refreshQueue,
    encryptionKey,
    oauthStateSecret: env.OAUTH_STATE_SECRET,
  },
  accounts: {
    pool,
    encryptionKey,
  },
  backfill: {
    pool,
    backfillQueue,
  },
  webhooks: {
    pool,
    leadWebhookQueue,
  },
  logLevel: env.LOG_LEVEL,
});

// --- Startup reconciliation ---
// Ensure all active accounts have poll jobs scheduled
const client = await pool.connect();
try {
  const activeAccounts = await accountsRepo.findActiveAccounts(client);
  for (const account of activeAccounts) {
    await upsertPollJob(pollQueue, account.id);
    // Schedule token refresh for non-Meta accounts with token_expires_at
    if (account.token_expires_at && account.platform !== 'facebook_ads') {
      await scheduleTokenRefresh(refreshQueue, account);
    }
  }
  log.info({ count: activeAccounts.length }, 'startup reconciliation: poll jobs upserted for active accounts');
} finally {
  client.release();
}

// --- Start server ---
await app.listen({ port: env.PORT, host: '0.0.0.0' });
log.info(`integration-hub started on port ${env.PORT}`);

// --- Graceful shutdown ---
async function shutdown(): Promise<void> {
  log.info('shutting down integration-hub');
  await app.close();
  await Promise.all(workers.map((w) => w.close()));
  await pollQueue.close();
  await refreshQueue.close();
  await leadWebhookQueue.close();
  await backfillQueue.close();
  await redis.quit();
  await pool.end();
  log.info('integration-hub shutdown complete');
}

process.on('SIGTERM', () => {
  shutdown().catch((err) => {
    log.error({ err }, 'error during shutdown');
    process.exit(1);
  });
});

process.on('SIGINT', () => {
  shutdown().catch((err) => {
    log.error({ err }, 'error during shutdown');
    process.exit(1);
  });
});
