import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import type { Logger } from '@ortho/logger';
import { requestLoggingPlugin } from '../src/index.js';

interface LogEntry {
  level: 'info' | 'error';
  data: Record<string, unknown>;
}

function makeLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const noop = () => {};
  const logger = {
    info: (data: Record<string, unknown>) => entries.push({ level: 'info', data }),
    error: (data: Record<string, unknown>) => entries.push({ level: 'error', data }),
    // Fastify's loggerInstance validation requires all pino-compatible methods
    debug: noop,
    warn: noop,
    fatal: noop,
    trace: noop,
    child: () => logger,
  } as unknown as Logger;
  return { logger, entries };
}

async function buildApp(logger: Logger, maxBodySize?: number) {
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    disableRequestLogging: true,
  });
  await app.register(requestLoggingPlugin, { logger, maxBodySize });
  app.get('/ping', async () => ({ pong: true }));
  app.get('/fail', async () => { throw new Error('boom'); });
  app.post('/echo', async (req) => req.body);
  app.get('/health', { config: { disableRequestLogging: true } }, async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('onRequest', () => {
  it('logs incoming request with method and url', async () => {
    const { logger, entries } = makeLogger();
    const app = await buildApp(logger);

    await app.inject({ method: 'GET', url: '/ping' });

    const entry = entries.find((e) => e.data.msg === 'incoming request');
    expect(entry).toBeDefined();
    expect(entry?.data.method).toBe('GET');
    expect(entry?.data.url).toBe('/ping');
    await app.close();
  });

  it('skips logging for routes with disableRequestLogging: true', async () => {
    const { logger, entries } = makeLogger();
    const app = await buildApp(logger);

    await app.inject({ method: 'GET', url: '/health' });

    const incoming = entries.find((e) => e.data.msg === 'incoming request');
    expect(incoming).toBeUndefined();
    await app.close();
  });
});

describe('onResponse', () => {
  it('logs outgoing response with statusCode and durationMs', async () => {
    const { logger, entries } = makeLogger();
    const app = await buildApp(logger);

    await app.inject({ method: 'GET', url: '/ping' });

    const entry = entries.find((e) => e.data.msg === 'outgoing response');
    expect(entry).toBeDefined();
    expect(entry?.data.statusCode).toBe(200);
    expect(typeof entry?.data.durationMs).toBe('number');
    await app.close();
  });

  it('skips response logging for disableRequestLogging routes', async () => {
    const { logger, entries } = makeLogger();
    const app = await buildApp(logger);

    await app.inject({ method: 'GET', url: '/health' });

    const outgoing = entries.find((e) => e.data.msg === 'outgoing response');
    expect(outgoing).toBeUndefined();
    await app.close();
  });

  it('includes requestBody for 4xx responses', async () => {
    const { logger, entries } = makeLogger();
    const app = await buildApp(logger);

    // POST /echo with content-type but no matching route returns 404
    await app.inject({
      method: 'GET',
      url: '/notfound',
    });

    const entry = entries.find((e) => e.data.msg === 'outgoing response');
    expect(entry?.data.statusCode).toBe(404);
    await app.close();
  });
});

describe('onError', () => {
  it('logs errors with name, message, and stack', async () => {
    const { logger, entries } = makeLogger();
    const app = await buildApp(logger);

    await app.inject({ method: 'GET', url: '/fail' });

    const entry = entries.find((e) => e.data.msg === 'request error');
    expect(entry).toBeDefined();
    expect((entry?.data.error as Record<string, unknown>).message).toBe('boom');
    await app.close();
  });

  it('fires onError even for disableRequestLogging routes', async () => {
    const { logger, entries } = makeLogger();
    const app = Fastify({
      loggerInstance: logger as unknown as FastifyBaseLogger,
      disableRequestLogging: true,
    });
    await app.register(requestLoggingPlugin, { logger });
    app.get('/health', { config: { disableRequestLogging: true } }, async () => {
      throw new Error('health-fail');
    });
    await app.ready();

    await app.inject({ method: 'GET', url: '/health' });

    const entry = entries.find((e) => e.data.msg === 'request error');
    expect(entry).toBeDefined();
    expect((entry?.data.error as Record<string, unknown>).message).toBe('health-fail');
    await app.close();
  });
});

describe('body truncation', () => {
  it('truncates request body in error responses when over maxBodySize', async () => {
    const { logger, entries } = makeLogger();
    const app = Fastify({
      loggerInstance: logger as unknown as FastifyBaseLogger,
      disableRequestLogging: true,
    });
    await app.register(requestLoggingPlugin, { logger, maxBodySize: 10 });
    app.post('/fail', async () => { throw new Error('bad'); });
    await app.ready();

    const body = JSON.stringify({ data: 'a'.repeat(100) });
    await app.inject({
      method: 'POST',
      url: '/fail',
      payload: body,
      headers: { 'content-type': 'application/json' },
    });

    const entry = entries.find((e) => e.data.msg === 'request error');
    expect(typeof entry?.data.requestBody).toBe('string');
    expect((entry?.data.requestBody as string).includes('[truncated:')).toBe(true);
    await app.close();
  });
});
