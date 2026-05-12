import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildApp } from '../app.js';
import { EventBusImpl, MockDriver } from '@ortho/event-bus';
import type { Knex } from '../db.js';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

function makeKnexStub(opts: { throws?: boolean } = {}): Knex {
  const raw = opts.throws ? vi.fn().mockRejectedValue(new Error('DB error')) : vi.fn().mockResolvedValue([]);
  return { raw } as unknown as Knex;
}

function makeQueuesStub(): { transactionalSend: Queue; campaignRecipient: Queue } {
  return {
    transactionalSend: { close: vi.fn() } as unknown as Queue,
    campaignRecipient: { add: vi.fn(), close: vi.fn() } as unknown as Queue,
  };
}

function makeRedisStub(opts: { throws?: boolean; response?: string } = {}): Redis {
  const ping = opts.throws
    ? vi.fn().mockRejectedValue(new Error('Redis error'))
    : vi.fn().mockResolvedValue(opts.response ?? 'PONG');
  return { ping } as unknown as Redis;
}

describe('GET /health', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    vi.restoreAllMocks();
  });

  it('returns 200 { status: ok, checks: { db: true, redis: true } } when both pass', async () => {
    const driver = new MockDriver();
    const eventBus = new EventBusImpl(driver);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    app = await buildApp(makeKnexStub(), eventBus, makeQueuesStub(), makeRedisStub());

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { db: true, redis: true } });
  });

  it('returns 503 with db: false when DB check throws', async () => {
    const driver = new MockDriver();
    const eventBus = new EventBusImpl(driver);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    app = await buildApp(makeKnexStub({ throws: true }), eventBus, makeQueuesStub(), makeRedisStub());

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', checks: { db: false, redis: true } });
  });

  it('returns 503 with redis: false when Redis PING fails', async () => {
    const driver = new MockDriver();
    const eventBus = new EventBusImpl(driver);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    app = await buildApp(makeKnexStub(), eventBus, makeQueuesStub(), makeRedisStub({ throws: true }));

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', checks: { db: true, redis: false } });
  });
});
