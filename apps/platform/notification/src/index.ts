import Fastify from 'fastify';
import knex from 'knex';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { NotificationsRepo } from './repositories/notifications.repo.js';
import { Publisher } from './services/publisher.js';
import { RateLimiter } from './services/rate-limiter.js';
import { SseManager } from './services/sse-manager.js';
import { publishRoute } from './routes/publish.js';
import { streamRoute } from './routes/stream.js';
import { notificationsRoute } from './routes/notifications.js';

export const app = Fastify({ logger: true });

// Shared DB + Redis clients (not created during test imports)
let publisher: Publisher | undefined;
let rateLimiter: RateLimiter | undefined;
let sseManager: SseManager | undefined;
let repo: NotificationsRepo | undefined;

if (process.env['NODE_ENV'] !== 'test') {
  const db = knex({
    client: 'pg',
    connection: config.DATABASE_URL,
    searchPath: ['platform_notifications'],
  });

  const redis = new Redis(config.REDIS_URL);
  const subRedis = new Redis(config.REDIS_URL);

  repo = new NotificationsRepo(db);
  publisher = new Publisher(repo, redis);
  rateLimiter = new RateLimiter(redis);
  sseManager = new SseManager(subRedis);
}

app.get('/health', async () => {
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
if (repo) {
  await app.register(notificationsRoute, {
    repo,
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
