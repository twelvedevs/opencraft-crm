import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildApp } from './app.js';
import { EventBusImpl, MockDriver } from '@ortho/event-bus';
import type { Knex } from './db.js';
import type { Queue } from 'bullmq';

function makeKnexStub(): Knex {
  return {} as unknown as Knex;
}

function makeQueuesStub(): { transactionalSend: Queue } {
  return { transactionalSend: { close: vi.fn() } as unknown as Queue };
}

describe('buildApp', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('calls eventBus.start() when app is ready', async () => {
    const driver = new MockDriver();
    const eventBus = new EventBusImpl(driver);
    const startSpy = vi.spyOn(eventBus, 'start');
    // suppress zero-subscriptions warning
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    app = await buildApp(makeKnexStub(), eventBus, makeQueuesStub());
    await app.ready();

    expect(startSpy).toHaveBeenCalledOnce();

    vi.restoreAllMocks();
  });

  it('calls eventBus.stop() when app is closed', async () => {
    const driver = new MockDriver();
    const eventBus = new EventBusImpl(driver);
    const stopSpy = vi.spyOn(eventBus, 'stop');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    app = await buildApp(makeKnexStub(), eventBus, makeQueuesStub());
    await app.ready();
    await app.close();
    app = undefined; // already closed, prevent double-close in afterEach

    expect(stopSpy).toHaveBeenCalledOnce();

    vi.restoreAllMocks();
  });

  it('GET /health returns 200 { status: "ok" }', async () => {
    const driver = new MockDriver();
    const eventBus = new EventBusImpl(driver);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    app = await buildApp(makeKnexStub(), eventBus, makeQueuesStub());

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });

    vi.restoreAllMocks();
  });
});
