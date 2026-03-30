import Fastify from 'fastify';
import knex, { type Knex } from 'knex';
import { Redis } from 'ioredis';
import { createSecretKey } from 'crypto';
import { SignJWT } from 'jose';
import http from 'http';
import { NotificationsRepo } from '../../src/repositories/notifications.repo.js';
import { Publisher } from '../../src/services/publisher.js';
import { RateLimiter } from '../../src/services/rate-limiter.js';
import { SseManager } from '../../src/services/sse-manager.js';
import { publishRoute } from '../../src/routes/publish.js';
import { streamRoute } from '../../src/routes/stream.js';
import { notificationsRoute } from '../../src/routes/notifications.js';
import { up as migrationUp } from '../../migrations/001_create_notifications.js';

export const TEST_JWT_SECRET = 'integration-test-secret-32-chars-ok!';
export const TEST_DB_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5432/postgres';
export const TEST_REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

export async function resetSchema(db: Knex): Promise<void> {
  await db.raw('DROP SCHEMA IF EXISTS platform_notifications CASCADE');
  await migrationUp(db);
}

export async function truncateTables(db: Knex): Promise<void> {
  await db.raw('TRUNCATE platform_notifications.notification_reads CASCADE');
  await db.raw(
    'TRUNCATE platform_notifications.notifications RESTART IDENTITY CASCADE',
  );
}

export async function makeUserToken(sub: string, locations?: string[]): Promise<string> {
  const secretKey = createSecretKey(Buffer.from(TEST_JWT_SECRET, 'utf-8'));
  return new SignJWT({ sub, ...(locations ? { locations } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secretKey);
}

export async function makeServiceToken(): Promise<string> {
  const secretKey = createSecretKey(Buffer.from(TEST_JWT_SECRET, 'utf-8'));
  return new SignJWT({ iss: 'test-service', sub: 'service' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secretKey);
}

export interface TestContext {
  app: ReturnType<typeof Fastify>;
  db: Knex;
  redis: Redis;
  subRedis: Redis;
  repo: NotificationsRepo;
  publisher: Publisher;
  rateLimiter: RateLimiter;
  sseManager: SseManager;
  serverUrl: string;
  close: () => Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  const db = knex({
    client: 'pg',
    connection: TEST_DB_URL,
    searchPath: ['platform_notifications'],
  });

  const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 3 });
  const subRedis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 3 });

  const repo = new NotificationsRepo(db);
  const publisher = new Publisher(repo, redis);
  const rateLimiter = new RateLimiter(redis);
  const sseManager = new SseManager(subRedis);

  const app = Fastify({ logger: false });

  await app.register(publishRoute, { publisher, rateLimiter, jwtSecret: TEST_JWT_SECRET });
  await app.register(streamRoute, { sseManager, repo, jwtSecret: TEST_JWT_SECRET });
  await app.register(notificationsRoute, { repo, redis, jwtSecret: TEST_JWT_SECRET });

  app.get('/health', async () => ({ status: 'ok' }));

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const serverUrl = `http://127.0.0.1:${port}`;

  const close = async () => {
    await app.close();
    redis.disconnect();
    subRedis.disconnect();
    await db.destroy();
  };

  return {
    app,
    db,
    redis,
    subRedis,
    repo,
    publisher,
    rateLimiter,
    sseManager,
    serverUrl,
    close,
  };
}

// SseCollector — connects to SSE endpoint and collects events

export interface SseEvent {
  event: string;
  data: unknown;
}

export class SseCollector {
  private req: http.ClientRequest | null = null;
  private events: SseEvent[] = [];
  private buffer = '';
  private currentEvent: { event?: string; data?: string } = {};
  private waiters: Array<{
    count: number;
    resolve: (events: SseEvent[]) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private headersReceived = false;
  public connectionId: string | null = null;
  public statusCode: number | null = null;

  connect(url: string, headers: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      this.req = http.get(
        {
          hostname: parsedUrl.hostname,
          port: parseInt(parsedUrl.port, 10),
          path: parsedUrl.pathname + parsedUrl.search,
          headers,
        },
        (res) => {
          this.statusCode = res.statusCode ?? null;
          this.connectionId = (res.headers['x-connection-id'] as string | undefined) ?? null;
          this.headersReceived = true;
          resolve();

          res.on('data', (chunk: Buffer) => {
            this.handleData(chunk.toString());
          });

          res.on('end', () => {
            for (const waiter of this.waiters) {
              clearTimeout(waiter.timer);
              waiter.resolve([...this.events]);
            }
            this.waiters = [];
          });

          res.on('error', (err) => {
            for (const waiter of this.waiters) {
              clearTimeout(waiter.timer);
              waiter.reject(err as Error);
            }
            this.waiters = [];
          });
        },
      );

      this.req.on('error', (err) => {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === 'ECONNRESET' && this.headersReceived) {
          for (const waiter of this.waiters) {
            clearTimeout(waiter.timer);
            waiter.resolve([...this.events]);
          }
          this.waiters = [];
        } else if (!this.headersReceived) {
          reject(err);
        }
      });
    });
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    const parts = this.buffer.split('\n');
    this.buffer = parts.pop() ?? '';

    for (const line of parts) {
      if (line === '') {
        if (this.currentEvent.event !== undefined && this.currentEvent.data !== undefined) {
          let parsedData: unknown;
          try {
            parsedData = JSON.parse(this.currentEvent.data);
          } catch {
            parsedData = this.currentEvent.data;
          }
          this.events.push({ event: this.currentEvent.event, data: parsedData });
          this.checkWaiters();
        }
        this.currentEvent = {};
      } else if (line.startsWith('event: ')) {
        this.currentEvent.event = line.slice(7);
      } else if (line.startsWith('data: ')) {
        this.currentEvent.data = line.slice(6);
      }
      // Ignore comment lines (keepalive: ': keepalive')
    }
  }

  private checkWaiters(): void {
    for (const waiter of [...this.waiters]) {
      if (this.events.length >= waiter.count) {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        clearTimeout(waiter.timer);
        waiter.resolve([...this.events]);
      }
    }
  }

  waitForEvents(count: number, timeoutMs = 5000): Promise<SseEvent[]> {
    if (this.events.length >= count) {
      return Promise.resolve([...this.events]);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(
          new Error(`Timeout: expected ${count} events, got ${this.events.length}`),
        );
      }, timeoutMs);
      this.waiters.push({ count, resolve, reject, timer });
    });
  }

  getEvents(): SseEvent[] {
    return [...this.events];
  }

  close(): void {
    this.req?.destroy();
  }
}
