import knex, { type Knex } from 'knex';
import { Redis } from 'ioredis';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { EventBusImpl, MockDriver } from '@ortho/event-bus';
import { buildApp } from '../../src/app.js';
import { createStubTwilioClient, type TwilioClient } from '../../src/services/twilio-client.js';
import { up as migrationUp, down as migrationDown } from '../../migrations/001_initial_schema.js';

export const TEST_DB_URL =
  process.env['DATABASE_URL'] ?? 'postgres://test:test@localhost:5432/test';
export const TEST_REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
export const TEST_AUTH_TOKEN = process.env['TWILIO_AUTH_TOKEN'] ?? 'test-auth-token';
export const TEST_STATUS_CALLBACK_URL = 'http://localhost:3000/webhooks/twilio/status';

/**
 * Check if Postgres and Redis are reachable. Returns true if both are available.
 */
export async function checkInfra(): Promise<boolean> {
  try {
    const db = knex({ client: 'pg', connection: TEST_DB_URL });
    await db.raw('SELECT 1');
    await db.destroy();
  } catch {
    return false;
  }
  try {
    const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
    await redis.connect();
    await redis.ping();
    redis.disconnect();
  } catch {
    return false;
  }
  return true;
}

export interface TestContext {
  app: FastifyInstance;
  db: Knex;
  redis: Redis;
  mockDriver: MockDriver;
  twilioStub: TwilioClient & { calls: Array<Record<string, unknown>>; setError(err?: Error): void };
  serverUrl: string;
  close: () => Promise<void>;
}

export async function resetSchema(db: Knex): Promise<void> {
  await migrationDown(db);
  await migrationUp(db);
}

export async function truncateTables(db: Knex): Promise<void> {
  await db.raw('TRUNCATE messaging_opt_outs CASCADE');
  await db.raw('TRUNCATE messaging_messages CASCADE');
  await db.raw('TRUNCATE messaging_numbers CASCADE');
}

export async function createTestContext(): Promise<TestContext> {
  const db = knex({
    client: 'pg',
    connection: TEST_DB_URL,
  });

  const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 3 });
  const mockDriver = new MockDriver();
  const eventBus = new EventBusImpl(mockDriver);
  const twilioStub = createStubTwilioClient();

  const app = await buildApp(db, eventBus, redis, twilioStub, TEST_STATUS_CALLBACK_URL);

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const serverUrl = `http://127.0.0.1:${port}`;

  const close = async () => {
    await app.close();
    redis.disconnect();
    await db.destroy();
  };

  return {
    app,
    db,
    redis,
    mockDriver,
    twilioStub,
    serverUrl,
    close,
  };
}

/**
 * Generate a valid Twilio HMAC-SHA1 signature for test webhooks.
 */
export function generateTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return createHmac('sha1', authToken).update(data).digest('base64');
}
