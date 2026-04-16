import Fastify from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import knex from 'knex';
import { Redis } from 'ioredis';
import { openapiPlugin } from '@ortho/openapi';
import { createLogger } from '@ortho/logger';
import { requestLoggingPlugin } from '@ortho/fastify-logger';
import { config } from './config.js';
import { NotificationsRepo } from './repositories/notifications.repo.js';
import { Publisher } from './services/publisher.js';
import { RateLimiter } from './services/rate-limiter.js';
import { SseManager } from './services/sse-manager.js';
import { publishRoute } from './routes/publish.js';
import { streamRoute } from './routes/stream.js';
import { notificationsRoute } from './routes/notifications.js';
import { createPublishRetryWorker } from './queue/publish-retry.worker.js';
import { createCleanupWorker } from './queue/cleanup.worker.js';

const log = createLogger('platform-notification');

export const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });

await app.register(openapiPlugin, {
  title: 'Notification Service',
  description: 'Real-time in-app notifications via SSE',
  tags: [
    { name: 'Notifications', description: 'Notification management' },
    { name: 'Publish', description: 'Publish notifications' },
    { name: 'Stream', description: 'Real-time SSE stream' },
  ],
});

await app.register(requestLoggingPlugin, { logger: log });

// Shared DB + Redis clients (not created during test imports)
let publisher: Publisher | undefined;
let rateLimiter: RateLimiter | undefined;
let sseManager: SseManager | undefined;
let repo: NotificationsRepo | undefined;
let redis: Redis | undefined;

if (process.env['NODE_ENV'] !== 'test') {
  const db = knex({
    client: 'pg',
    connection: config.DATABASE_URL,
    searchPath: ['platform_notifications'],
  });

  redis = new Redis(config.REDIS_URL);
  const subRedis = new Redis(config.REDIS_URL);

  repo = new NotificationsRepo(db);
  publisher = new Publisher(repo, redis);
  rateLimiter = new RateLimiter(redis);
  sseManager = new SseManager(subRedis);

  // Start publish-retry BullMQ worker (uses its own Redis connections)
  createPublishRetryWorker(config.REDIS_URL);

  // Start daily cleanup worker — deletes expired notifications at 2:00 AM UTC
  createCleanupWorker(config.REDIS_URL, repo);
}

app.get('/health', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async () => {
  return { status: 'ok' };
});

// Register publish route (only when dependencies are available)
if (publisher && rateLimiter) {
  await app.register(publishRoute, {
    publisher,
    rateLimiter,
    jwtSecret: config.JWT_HMAC_SECRET,
  });
}

// Register SSE stream route (only when dependencies are available)
if (sseManager && repo) {
  await app.register(streamRoute, {
    sseManager,
    repo,
    jwtSecret: config.JWT_HMAC_SECRET,
  });
}

// Register notifications history + mark-read routes
if (repo && redis) {
  await app.register(notificationsRoute, {
    repo,
    redis,
    jwtSecret: config.JWT_HMAC_SECRET,
  });
}

if (process.env['NODE_ENV'] !== 'test') {
  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

export { sseManager };
