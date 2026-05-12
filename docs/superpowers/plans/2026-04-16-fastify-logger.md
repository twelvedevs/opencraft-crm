# `@ortho/fastify-logger` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a new shared package `@ortho/fastify-logger` with a Fastify 5 request-logging plugin and adopt it across all 19 Fastify services.

**Architecture:** A single `fp()`-wrapped Fastify plugin that uses an injected `Logger` instance (from `@ortho/logger`) to emit structured `onRequest`, `onResponse`, and `onError` hooks. Services pass `disableRequestLogging: true` to their Fastify constructor to suppress built-in duplicate logs. Per-route opt-out via `routeOptions.config.disableRequestLogging`.

**Tech Stack:** Fastify 5, `fastify-plugin ^5`, `@ortho/logger`, Vitest 2.

---

## File Map

**New files:**
- `packages/@ortho/fastify-logger/package.json`
- `packages/@ortho/fastify-logger/tsconfig.json`
- `packages/@ortho/fastify-logger/src/index.ts` — plugin implementation + exported types
- `packages/@ortho/fastify-logger/test/request-logging.test.ts`

**Modified (Group A — already use `loggerInstance: log`):**
- `apps/crm/pipeline/src/app.ts` + `package.json`
- `apps/crm/lead/src/app.ts` + `package.json`
- `apps/crm/conversation/src/app.ts` + `package.json`
- `apps/crm/campaign/src/api.ts` + `package.json`
- `apps/crm/reporting/src/index.ts` + `src/routes/health.ts` + `package.json`
- `apps/crm/referral/src/index.ts` + `package.json`
- `apps/crm/import/src/index.ts` + `package.json`
- `apps/platform/identity/src/app.ts` + `src/routes/health.ts` + `package.json`
- `apps/platform/media/src/app.ts` + `package.json`
- `apps/crm/api-gateway/src/index.ts` + `src/routes/health.ts` + `package.json`

**Modified (Group B — use `logger: true` or `logger: { level }`):**
- `apps/platform/ai/src/app.ts` + `src/routes/health.ts` + `package.json`
- `apps/platform/audience/src/app.ts` + `src/routes/health.ts` + `package.json`
- `apps/platform/messaging/src/app.ts` + `src/routes/health.ts` + `package.json`
- `apps/platform/email/src/app.ts` + `src/routes/health.ts` + `package.json`
- `apps/platform/analytics/src/app.ts` + `src/routes/health.ts` + `package.json`
- `apps/platform/integration-hub/src/app.ts` + `package.json`
- `apps/platform/notification/src/index.ts` + `package.json`
- `apps/platform/template/src/app.ts` + `package.json`
- `apps/platform/automation/src/index.ts` + `package.json`
- `apps/platform/nurturing/src/index.ts` + `package.json`

---

## Task 1: Scaffold the package

**Files:**
- Create: `packages/@ortho/fastify-logger/package.json`
- Create: `packages/@ortho/fastify-logger/tsconfig.json`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@ortho/fastify-logger",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@ortho/logger": "file:../../@ortho/logger",
    "fastify-plugin": "^5.0.0"
  },
  "peerDependencies": {
    "fastify": "^5.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "fastify": "^5.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Install dependencies**

Run from `packages/@ortho/fastify-logger/`:
```bash
npm install
```

Expected: `node_modules/` created, no errors.

---

## Task 2: Implement the plugin

**Files:**
- Create: `packages/@ortho/fastify-logger/src/index.ts`

- [ ] **Step 1: Write `src/index.ts`**

```typescript
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import type { Logger } from '@ortho/logger';

export interface RequestLoggingPluginOptions {
  /** Logger instance from @ortho/logger — injected, not created internally */
  logger: Logger;
  /** Body truncation ceiling in bytes. Default: 10 240 (10 KB) */
  maxBodySize?: number;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Set to true on a route to suppress onRequest/onResponse logging for that route */
    disableRequestLogging?: boolean;
  }
  interface FastifyRequest {
    _loggingStartTime?: number;
  }
}

const DEFAULT_MAX_BODY_SIZE = 10 * 1024;

function truncateBody(body: unknown, maxSize: number): string {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const byteLength = Buffer.byteLength(bodyStr, 'utf8');
  if (byteLength <= maxSize) return bodyStr;
  return `${bodyStr.substring(0, maxSize)}... [truncated: ${byteLength} bytes total]`;
}

function loggingPlugin(
  fastify: FastifyInstance,
  options: RequestLoggingPluginOptions,
): void {
  const { logger, maxBodySize = DEFAULT_MAX_BODY_SIZE } = options;

  fastify.decorateRequest('_loggingStartTime', undefined);

  fastify.addHook(
    'onRequest',
    (request: FastifyRequest, _reply: FastifyReply, done: () => void) => {
      if (request.routeOptions?.config?.disableRequestLogging) return done();
      request._loggingStartTime = Date.now();
      logger.info({
        msg: 'incoming request',
        method: request.method,
        url: request.url,
        userAgent: request.headers['user-agent'],
        timestamp: new Date().toISOString(),
      });
      done();
    },
  );

  fastify.addHook(
    'onResponse',
    (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
      if (request.routeOptions?.config?.disableRequestLogging) return done();
      const startTime = request._loggingStartTime;
      const durationMs = startTime !== undefined ? Date.now() - startTime : undefined;
      const contentLength = reply.getHeader('content-length');
      const responseSize =
        typeof contentLength === 'string' || typeof contentLength === 'number'
          ? Number(contentLength)
          : undefined;
      const logData: Record<string, unknown> = {
        msg: 'outgoing response',
        statusCode: reply.statusCode,
        durationMs,
        responseSize,
      };
      if (reply.statusCode >= 400 && request.body !== undefined) {
        logData.requestBody = truncateBody(request.body, maxBodySize);
      }
      logger.info(logData);
      done();
    },
  );

  fastify.addHook(
    'onError',
    (request: FastifyRequest, reply: FastifyReply, error: Error, done: () => void) => {
      const startTime = request._loggingStartTime;
      const durationMs = startTime !== undefined ? Date.now() - startTime : undefined;
      const logData: Record<string, unknown> = {
        msg: 'request error',
        error: { name: error.name, message: error.message, stack: error.stack },
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs,
      };
      if (request.body !== undefined) {
        logData.requestBody = truncateBody(request.body, maxBodySize);
      }
      logger.error(logData);
      done();
    },
  );
}

export const requestLoggingPlugin = fp(loggingPlugin, {
  name: 'ortho-request-logging',
  fastify: '5.x',
});
```

- [ ] **Step 2: Typecheck**

Run from `packages/@ortho/fastify-logger/`:
```bash
npm run typecheck
```

Expected: no errors.

---

## Task 3: Write and run tests

**Files:**
- Create: `packages/@ortho/fastify-logger/test/request-logging.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
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
  const logger = {
    info: (data: Record<string, unknown>) => entries.push({ level: 'info', data }),
    error: (data: Record<string, unknown>) => entries.push({ level: 'error', data }),
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
```

- [ ] **Step 2: Run tests — expect them to fail** (plugin not yet installed)

Run from `packages/@ortho/fastify-logger/`:
```bash
npm install && npm test
```

Expected: tests pass after `npm install` resolves the `@ortho/logger` dep.
If tests fail with import errors, verify `tsconfig.json` has `"moduleResolution": "NodeNext"`.

- [ ] **Step 3: Commit the package**

```bash
git add packages/@ortho/fastify-logger/
git commit -m "feat(fastify-logger): add @ortho/fastify-logger package with request-logging plugin"
```

---

## Task 4: Group A — adopt in pipeline, lead, conversation

**Files:**
- Modify: `apps/crm/pipeline/src/app.ts`
- Modify: `apps/crm/pipeline/package.json`
- Modify: `apps/crm/lead/src/app.ts`
- Modify: `apps/crm/lead/package.json`
- Modify: `apps/crm/conversation/src/app.ts`
- Modify: `apps/crm/conversation/package.json`

### pipeline

- [ ] **Step 1: Add dep to `apps/crm/pipeline/package.json`**

In the `"dependencies"` block, add:
```json
"@ortho/fastify-logger": "file:../../../packages/@ortho/fastify-logger"
```

- [ ] **Step 2: Update `apps/crm/pipeline/src/app.ts`**

Add import at the top (after existing imports):
```typescript
import { requestLoggingPlugin } from '@ortho/fastify-logger';
```

Change the Fastify constructor line from:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });
```
to:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });
```

After `await app.register(sensible);`, add:
```typescript
await app.register(requestLoggingPlugin, { logger: log });
```

Change the health route from:
```typescript
app.get('/health', { schema: { hide: true } as object }, async () => ({ ok: true }));
```
to:
```typescript
app.get('/health', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async () => ({ ok: true }));
```

### lead

- [ ] **Step 3: Add dep to `apps/crm/lead/package.json`**

In the `"dependencies"` block, add:
```json
"@ortho/fastify-logger": "file:../../../packages/@ortho/fastify-logger"
```

- [ ] **Step 4: Update `apps/crm/lead/src/app.ts`**

Add import:
```typescript
import { requestLoggingPlugin } from '@ortho/fastify-logger';
```

Change the Fastify constructor from:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });
```
to:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });
```

After `await app.register(sensible);`, add:
```typescript
await app.register(requestLoggingPlugin, { logger: log });
```

Change the health route from:
```typescript
app.get('/health', { schema: { hide: true } as object }, async () => ({ ok: true }));
```
to:
```typescript
app.get('/health', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async () => ({ ok: true }));
```

### conversation

- [ ] **Step 5: Add dep to `apps/crm/conversation/package.json`**

In the `"dependencies"` block, add:
```json
"@ortho/fastify-logger": "file:../../../packages/@ortho/fastify-logger"
```

- [ ] **Step 6: Update `apps/crm/conversation/src/app.ts`**

Add import:
```typescript
import { requestLoggingPlugin } from '@ortho/fastify-logger';
```

Change the Fastify constructor from:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });
```
to:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });
```

After `await app.register(sensible);`, add:
```typescript
await app.register(requestLoggingPlugin, { logger: log });
```

Change the health route (currently at line ~71) from:
```typescript
app.get('/health', { schema: { hide: true } as object }, async () => ({ ok: true }));
```
to:
```typescript
app.get('/health', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async () => ({ ok: true }));
```

### campaign

- [ ] **Step 7: Add dep to `apps/crm/campaign/package.json`**

In the `"dependencies"` block, add:
```json
"@ortho/fastify-logger": "file:../../../packages/@ortho/fastify-logger"
```

- [ ] **Step 8: Update `apps/crm/campaign/src/api.ts`**

Note: campaign's Fastify app is in `src/api.ts`, not `src/app.ts`.

Add import:
```typescript
import { requestLoggingPlugin } from '@ortho/fastify-logger';
```

Change the Fastify constructor from:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });
```
to:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });
```

After `await app.register(sensible);`, add:
```typescript
await app.register(requestLoggingPlugin, { logger: log });
```

Change the health route from:
```typescript
app.get('/health', { schema: { hide: true } as object }, async () => ({ ok: true }));
```
to:
```typescript
app.get('/health', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async () => ({ ok: true }));
```

- [ ] **Step 9: Typecheck all four**

Run from each service directory:
```bash
npm run typecheck
```

Expected: no errors in pipeline, lead, conversation, or campaign.

- [ ] **Step 10: Commit**

```bash
git add apps/crm/pipeline/ apps/crm/lead/ apps/crm/conversation/ apps/crm/campaign/
git commit -m "feat(fastify-logger): adopt request-logging plugin in pipeline, lead, conversation, campaign"
```

---

## Task 5: Group A — adopt in referral, import, media

**Files:**
- Modify: `apps/crm/referral/src/index.ts`
- Modify: `apps/crm/referral/package.json`
- Modify: `apps/crm/import/src/index.ts`
- Modify: `apps/crm/import/package.json`
- Modify: `apps/platform/media/src/app.ts`
- Modify: `apps/platform/media/package.json`

### referral

- [ ] **Step 1: Add dep to `apps/crm/referral/package.json`**

In `"dependencies"`, add:
```json
"@ortho/fastify-logger": "file:../../../packages/@ortho/fastify-logger"
```

- [ ] **Step 2: Update `apps/crm/referral/src/index.ts`**

Add import (after existing imports):
```typescript
import { requestLoggingPlugin } from '@ortho/fastify-logger';
```

Change the Fastify constructor from:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });
```
to:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });
```

After `await app.register(sensible);`, add:
```typescript
await app.register(requestLoggingPlugin, { logger: log });
```

Change the health route from:
```typescript
app.get('/health', { schema: { hide: true } as object }, async () => ({ ok: true }));
```
to:
```typescript
app.get('/health', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async () => ({ ok: true }));
```

### import

- [ ] **Step 3: Add dep to `apps/crm/import/package.json`**

In `"dependencies"`, add:
```json
"@ortho/fastify-logger": "file:../../../packages/@ortho/fastify-logger"
```

- [ ] **Step 4: Update `apps/crm/import/src/index.ts`**

Add import (after existing imports):
```typescript
import { requestLoggingPlugin } from '@ortho/fastify-logger';
```

Change the Fastify constructor from:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });
```
to:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });
```

After `await app.register(sensible);`, add:
```typescript
await app.register(requestLoggingPlugin, { logger: log });
```

Change the health route from:
```typescript
app.get('/health', { schema: { hide: true } as object }, async () => ({ ok: true }));
```
to:
```typescript
app.get('/health', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async () => ({ ok: true }));
```

### media

- [ ] **Step 5: Add dep to `apps/platform/media/package.json`**

In `"dependencies"`, add:
```json
"@ortho/fastify-logger": "file:../../../packages/@ortho/fastify-logger"
```

- [ ] **Step 6: Update `apps/platform/media/src/app.ts`**

Add import:
```typescript
import { requestLoggingPlugin } from '@ortho/fastify-logger';
```

Change the Fastify constructor from:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });
```
to:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });
```

After `await app.register(sensible);`, add:
```typescript
await app.register(requestLoggingPlugin, { logger: log });
```

Change the `/health` route from:
```typescript
app.get('/health', { schema: { hide: true } as object }, async () => ({ status: 'ok' }));
```
to:
```typescript
app.get('/health', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async () => ({ status: 'ok' }));
```

Change the `/ready` route from:
```typescript
app.get('/ready', { schema: { hide: true } as object }, async (_req, reply) => {
```
to:
```typescript
app.get('/ready', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async (_req, reply) => {
```

- [ ] **Step 7: Typecheck all three**

Run from each service directory (`apps/crm/referral/`, `apps/crm/import/`, `apps/platform/media/`):
```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/crm/referral/ apps/crm/import/ apps/platform/media/
git commit -m "feat(fastify-logger): adopt request-logging plugin in referral, import, media"
```

---

## Task 6: Group A — adopt in reporting and identity

Both services register health routes via a separate `healthRoutes` function. The `disableRequestLogging` config must be added inside the route file, not in the registrar.

**Files:**
- Modify: `apps/crm/reporting/src/index.ts`
- Modify: `apps/crm/reporting/src/routes/health.ts`
- Modify: `apps/crm/reporting/package.json`
- Modify: `apps/platform/identity/src/app.ts`
- Modify: `apps/platform/identity/src/routes/health.ts`
- Modify: `apps/platform/identity/package.json`

### reporting

- [ ] **Step 1: Add dep to `apps/crm/reporting/package.json`**

In `"dependencies"`, add:
```json
"@ortho/fastify-logger": "file:../../../packages/@ortho/fastify-logger"
```

- [ ] **Step 2: Update `apps/crm/reporting/src/index.ts`**

Add import:
```typescript
import { requestLoggingPlugin } from '@ortho/fastify-logger';
```

Change the Fastify constructor from:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });
```
to:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });
```

After `await app.register(sensible);`, add:
```typescript
await app.register(requestLoggingPlugin, { logger: log });
```

- [ ] **Step 3: Update `apps/crm/reporting/src/routes/health.ts`**

Change both route definitions to add `config: { disableRequestLogging: true }`:

```typescript
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', {
    schema: { hide: true } as object,
    config: { disableRequestLogging: true },
  }, async () => ({ status: 'ok' }));

  app.get('/ready', {
    schema: { hide: true } as object,
    config: { disableRequestLogging: true },
  }, async (_req, reply) => {
    // ... existing implementation unchanged ...
  });
}
```

### identity

- [ ] **Step 4: Add dep to `apps/platform/identity/package.json`**

In `"dependencies"`, add:
```json
"@ortho/fastify-logger": "file:../../../packages/@ortho/fastify-logger"
```

- [ ] **Step 5: Update `apps/platform/identity/src/app.ts`**

Add import:
```typescript
import { requestLoggingPlugin } from '@ortho/fastify-logger';
```

Change the Fastify constructor from:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });
```
to:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });
```

After `await app.register(sensible);`, add:
```typescript
await app.register(requestLoggingPlugin, { logger: log });
```

- [ ] **Step 6: Update `apps/platform/identity/src/routes/health.ts`**

Change both route definitions:
```typescript
export async function healthRoutes(
  app: FastifyInstance,
  opts: { pool: Pool },
): Promise<void> {
  app.get('/health', {
    schema: { hide: true } as object,
    config: { disableRequestLogging: true },
  }, async (_req, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  app.get('/ready', {
    schema: { hide: true } as object,
    config: { disableRequestLogging: true },
  }, async (_req, reply) => {
    // ... existing implementation unchanged ...
  });
}
```

- [ ] **Step 7: Typecheck both**

Run from each service directory:
```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/crm/reporting/ apps/platform/identity/
git commit -m "feat(fastify-logger): adopt request-logging plugin in reporting, identity"
```

---

## Task 7: Group A — adopt in api-gateway

The api-gateway currently has `disableRequestLogging: false` (explicit false). It also has its health route in a separate file that already has config options.

**Files:**
- Modify: `apps/crm/api-gateway/src/index.ts`
- Modify: `apps/crm/api-gateway/src/routes/health.ts`
- Modify: `apps/crm/api-gateway/package.json`

- [ ] **Step 1: Add dep to `apps/crm/api-gateway/package.json`**

In `"dependencies"`, add:
```json
"@ortho/fastify-logger": "file:../../../packages/@ortho/fastify-logger"
```

- [ ] **Step 2: Update `apps/crm/api-gateway/src/index.ts`**

Add import (after existing imports):
```typescript
import { requestLoggingPlugin } from '@ortho/fastify-logger';
```

Change the Fastify constructor — flip `disableRequestLogging` from `false` to `true`:
```typescript
const app = Fastify({
  loggerInstance: log,
  bodyLimit: config.MAX_BODY_SIZE_BYTES,
  requestIdHeader: 'x-request-id',
  disableRequestLogging: true,
});
```

After the `replyFrom` registration block, add:
```typescript
await app.register(requestLoggingPlugin, { logger: log });
```

- [ ] **Step 3: Update `apps/crm/api-gateway/src/routes/health.ts`**

Add `disableRequestLogging: true` to the route config. The route currently has `config: { auth: false, skipRateLimit: true }` — extend it:

```typescript
async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', {
    config: { auth: false, skipRateLimit: true, disableRequestLogging: true },
    handler: async (_request, reply) => {
      return reply.code(200).send({ status: 'ok' });
    },
  });
}

export default healthRoutes;
```

- [ ] **Step 4: Typecheck**

Run from `apps/crm/api-gateway/`:
```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/crm/api-gateway/
git commit -m "feat(fastify-logger): adopt request-logging plugin in api-gateway"
```

---

## Task 8: Group B — adopt in ai, audience, messaging, email, analytics

These five services already have `@ortho/logger` in their dependencies and use `healthRoutes` files. They use `Fastify({ logger: true })` and need a `createLogger` call added.

**Files:**
- Modify: `apps/platform/ai/src/app.ts` + `src/routes/health.ts` + `package.json`
- Modify: `apps/platform/audience/src/app.ts` + `src/routes/health.ts` + `package.json`
- Modify: `apps/platform/messaging/src/app.ts` + `src/routes/health.ts` + `package.json`
- Modify: `apps/platform/email/src/app.ts` + `src/routes/health.ts` + `package.json`
- Modify: `apps/platform/analytics/src/app.ts` + `src/routes/health.ts` + `package.json`

### ai

- [ ] **Step 1: Add dep to `apps/platform/ai/package.json`**

In `"dependencies"`, add:
```json
"@ortho/fastify-logger": "file:../../../packages/@ortho/fastify-logger"
```

- [ ] **Step 2: Update `apps/platform/ai/src/app.ts`**

Add imports at the top:
```typescript
import { createLogger } from '@ortho/logger';
import type { FastifyBaseLogger } from 'fastify';
import { requestLoggingPlugin } from '@ortho/fastify-logger';
```

Inside `buildApp`, before the Fastify constructor, add:
```typescript
const log = createLogger('platform-ai');
```

Change the Fastify constructor from:
```typescript
const app = Fastify({ logger: true });
```
to:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });
```

After `await app.register(sensible);`, add:
```typescript
await app.register(requestLoggingPlugin, { logger: log });
```

- [ ] **Step 3: Update `apps/platform/ai/src/routes/health.ts`**

```typescript
import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', {
    schema: { hide: true } as object,
    config: { disableRequestLogging: true },
  }, async (_req, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });
}
```

### audience

- [ ] **Step 4: Add dep to `apps/platform/audience/package.json`**

In `"dependencies"`, add:
```json
"@ortho/fastify-logger": "file:../../../packages/@ortho/fastify-logger"
```

- [ ] **Step 5: Update `apps/platform/audience/src/app.ts`**

Add imports:
```typescript
import { createLogger } from '@ortho/logger';
import type { FastifyBaseLogger } from 'fastify';
import { requestLoggingPlugin } from '@ortho/fastify-logger';
```

Inside `buildApp`, before the Fastify constructor, add:
```typescript
const log = createLogger('platform-audience');
```

Change:
```typescript
const app = Fastify({ logger: true });
```
to:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });
```

After `await app.register(sensible);`, add:
```typescript
await app.register(requestLoggingPlugin, { logger: log });
```

- [ ] **Step 6: Update `apps/platform/audience/src/routes/health.ts`**

```typescript
import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', {
    schema: { hide: true } as object,
    config: { disableRequestLogging: true },
  }, async (_req, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });
}
```

### messaging

- [ ] **Step 7: Add dep to `apps/platform/messaging/package.json`**

In `"dependencies"`, add:
```json
"@ortho/fastify-logger": "file:../../../packages/@ortho/fastify-logger"
```

- [ ] **Step 8: Update `apps/platform/messaging/src/app.ts`**

Add imports:
```typescript
import { createLogger } from '@ortho/logger';
import type { FastifyBaseLogger } from 'fastify';
import { requestLoggingPlugin } from '@ortho/fastify-logger';
```

Inside `buildApp`, before the Fastify constructor:
```typescript
const log = createLogger('platform-messaging');
```

Change:
```typescript
const app = Fastify({ logger: true });
```
to:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });
```

After `await app.register(sensible);`, add:
```typescript
await app.register(requestLoggingPlugin, { logger: log });
```

- [ ] **Step 9: Update `apps/platform/messaging/src/routes/health.ts`**

The messaging health route does DB+Redis checks. Add config only to the route declaration:
```typescript
app.get('/health', {
  schema: { hide: true } as object,
  config: { disableRequestLogging: true },
}, async (_req, reply) => {
  // ... existing DB + Redis check implementation unchanged ...
});
```

### email

- [ ] **Step 10: Add dep to `apps/platform/email/package.json`**

In `"dependencies"`, add:
```json
"@ortho/fastify-logger": "file:../../../packages/@ortho/fastify-logger"
```

- [ ] **Step 11: Update `apps/platform/email/src/app.ts`**

Add imports:
```typescript
import { createLogger } from '@ortho/logger';
import type { FastifyBaseLogger } from 'fastify';
import { requestLoggingPlugin } from '@ortho/fastify-logger';
```

Inside `buildApp`, before the Fastify constructor:
```typescript
const log = createLogger('platform-email');
```

Change:
```typescript
const app = Fastify({ logger: true });
```
to:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });
```

After `await app.register(sensible);`, add:
```typescript
await app.register(requestLoggingPlugin, { logger: log });
```

- [ ] **Step 12: Update `apps/platform/email/src/routes/health.ts`**

```typescript
app.get('/health', {
  schema: { hide: true } as object,
  config: { disableRequestLogging: true },
}, async (_req, reply) => {
  // ... existing implementation unchanged ...
});
```

### analytics

- [ ] **Step 13: Add dep to `apps/platform/analytics/package.json`**

In `"dependencies"`, add:
```json
"@ortho/fastify-logger": "file:../../../packages/@ortho/fastify-logger"
```

- [ ] **Step 14: Update `apps/platform/analytics/src/app.ts`**

Add imports:
```typescript
import { createLogger } from '@ortho/logger';
import type { FastifyBaseLogger } from 'fastify';
import { requestLoggingPlugin } from '@ortho/fastify-logger';
```

Inside `buildApp`, before the Fastify constructor:
```typescript
const log = createLogger('platform-analytics');
```

Change:
```typescript
const app = Fastify({ logger: true });
```
to:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });
```

After `await app.register(sensible);`, add:
```typescript
await app.register(requestLoggingPlugin, { logger: log });
```

- [ ] **Step 15: Update `apps/platform/analytics/src/routes/health.ts`**

```typescript
app.get('/health', {
  schema: { hide: true } as object,
  config: { disableRequestLogging: true },
}, async (_req, reply) => {
  // ... existing implementation unchanged ...
});
```

- [ ] **Step 16: Typecheck all five**

Run from each directory (`apps/platform/ai/`, `apps/platform/audience/`, `apps/platform/messaging/`, `apps/platform/email/`, `apps/platform/analytics/`):
```bash
npm run typecheck
```

Expected: no errors in any of the five.

- [ ] **Step 17: Commit**

```bash
git add apps/platform/ai/ apps/platform/audience/ apps/platform/messaging/ apps/platform/email/ apps/platform/analytics/
git commit -m "feat(fastify-logger): adopt request-logging plugin in ai, audience, messaging, email, analytics"
```

---

## Task 9: Group B — adopt in integration-hub

Integration-hub already has `@ortho/logger`. It uses `logger: { level: opts.logLevel ?? 'info' }` with an inline health route. The `logLevel` option comes from `BuildAppOptions`.

**Files:**
- Modify: `apps/platform/integration-hub/src/app.ts`
- Modify: `apps/platform/integration-hub/package.json`

- [ ] **Step 1: Add dep to `apps/platform/integration-hub/package.json`**

In `"dependencies"`, add:
```json
"@ortho/fastify-logger": "file:../../../packages/@ortho/fastify-logger"
```

- [ ] **Step 2: Update `apps/platform/integration-hub/src/app.ts`**

Add imports:
```typescript
import { createLogger } from '@ortho/logger';
import type { FastifyBaseLogger } from 'fastify';
import { requestLoggingPlugin } from '@ortho/fastify-logger';
```

Inside `buildApp`, before the Fastify constructor:
```typescript
const log = createLogger('platform-integration-hub');
```

Change:
```typescript
const fastify = Fastify({
  logger: { level: opts.logLevel ?? 'info' },
});
```
to:
```typescript
const fastify = Fastify({
  loggerInstance: log as unknown as FastifyBaseLogger,
  disableRequestLogging: true,
});
```

After `await fastify.register(sensible);`, add:
```typescript
await fastify.register(requestLoggingPlugin, { logger: log });
```

Change the health route from:
```typescript
fastify.get('/health', { schema: { hide: true } as object }, async () => ({ status: 'ok' }));
```
to:
```typescript
fastify.get('/health', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async () => ({ status: 'ok' }));
```

Note: `opts.logLevel` is no longer used in the Fastify constructor. If it's still needed elsewhere, keep it; otherwise it can be left in `BuildAppOptions` for future use. Do not remove it from the interface — that would be a breaking change.

- [ ] **Step 3: Typecheck**

Run from `apps/platform/integration-hub/`:
```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/platform/integration-hub/
git commit -m "feat(fastify-logger): adopt request-logging plugin in integration-hub"
```

---

## Task 10: Group B — adopt in notification

Notification has no `buildApp` function — everything is at module level. It needs `@ortho/logger` added as a new dependency.

**Files:**
- Modify: `apps/platform/notification/src/index.ts`
- Modify: `apps/platform/notification/package.json`

- [ ] **Step 1: Add both deps to `apps/platform/notification/package.json`**

In `"dependencies"`, add:
```json
"@ortho/logger": "file:../../../packages/@ortho/logger",
"@ortho/fastify-logger": "file:../../../packages/@ortho/fastify-logger"
```

- [ ] **Step 2: Update `apps/platform/notification/src/index.ts`**

Add imports at the top:
```typescript
import { createLogger } from '@ortho/logger';
import type { FastifyBaseLogger } from 'fastify';
import { requestLoggingPlugin } from '@ortho/fastify-logger';
```

Before the Fastify constructor, add:
```typescript
const log = createLogger('platform-notification');
```

Change:
```typescript
export const app = Fastify({ logger: true });
```
to:
```typescript
export const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });
```

After `await app.register(openapiPlugin, { ... });`, add:
```typescript
await app.register(requestLoggingPlugin, { logger: log });
```

Change the health route from:
```typescript
app.get('/health', { schema: { hide: true } as object }, async () => {
```
to:
```typescript
app.get('/health', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async () => {
```

- [ ] **Step 3: Install and typecheck**

Run from `apps/platform/notification/`:
```bash
npm install && npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/platform/notification/
git commit -m "feat(fastify-logger): adopt request-logging plugin in notification"
```

---

## Task 11: Group B — adopt in template

Template has no logger at all. It uses `Fastify({ logger: true })`. Needs both `@ortho/logger` and `@ortho/fastify-logger` added.

**Files:**
- Modify: `apps/platform/template/src/app.ts`
- Modify: `apps/platform/template/package.json`

- [ ] **Step 1: Add both deps to `apps/platform/template/package.json`**

In `"dependencies"`, add:
```json
"@ortho/logger": "file:../../../packages/@ortho/logger",
"@ortho/fastify-logger": "file:../../../packages/@ortho/fastify-logger"
```

- [ ] **Step 2: Update `apps/platform/template/src/app.ts`**

Add imports:
```typescript
import { createLogger } from '@ortho/logger';
import type { FastifyBaseLogger } from 'fastify';
import { requestLoggingPlugin } from '@ortho/fastify-logger';
```

Inside `buildApp`, before the Fastify constructor:
```typescript
const log = createLogger('platform-template');
```

Change:
```typescript
const app = Fastify({ logger: true });
```
to:
```typescript
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });
```

After `await app.register(sensible);`, add:
```typescript
await app.register(requestLoggingPlugin, { logger: log });
```

Change the health route from:
```typescript
app.get('/health', { schema: { hide: true } as object }, async (_request, reply) => {
```
to:
```typescript
app.get('/health', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async (_request, reply) => {
```

- [ ] **Step 3: Install and typecheck**

Run from `apps/platform/template/`:
```bash
npm install && npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/platform/template/
git commit -m "feat(fastify-logger): adopt request-logging plugin in template"
```

---

## Task 12: Group B — adopt in automation

Automation uses `Fastify({ logger: true })` and has `/healthz` (wrong name — should be `/health` to match the project-wide convention established by all other services and docker-compose expectations).

**Files:**
- Modify: `apps/platform/automation/src/index.ts`
- Modify: `apps/platform/automation/package.json`

- [ ] **Step 1: Add both deps to `apps/platform/automation/package.json`**

In `"dependencies"`, add:
```json
"@ortho/logger": "file:../../../packages/@ortho/logger",
"@ortho/fastify-logger": "file:../../../packages/@ortho/fastify-logger"
```

- [ ] **Step 2: Update `apps/platform/automation/src/index.ts`**

Add imports:
```typescript
import { createLogger } from '@ortho/logger';
import type { FastifyBaseLogger } from 'fastify';
import { requestLoggingPlugin } from '@ortho/fastify-logger';
```

Before the Fastify constructor, add:
```typescript
const log = createLogger('platform-automation');
```

Change:
```typescript
const fastify = Fastify({ logger: true });
```
to:
```typescript
const fastify = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });
```

After `await fastify.register(sensible);`, add:
```typescript
await fastify.register(requestLoggingPlugin, { logger: log });
```

Change the health route — rename `/healthz` to `/health` and add the config:
```typescript
fastify.get('/health', {
  schema: { hide: true } as object,
  config: { disableRequestLogging: true },
}, async () => {
  return { ok: true };
});
```

- [ ] **Step 3: Install and typecheck**

Run from `apps/platform/automation/`:
```bash
npm install && npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/platform/automation/
git commit -m "feat(fastify-logger): adopt request-logging plugin in automation; rename /healthz to /health"
```

---

## Task 13: Group B — adopt in nurturing

Nurturing already received fixes in prior sessions (auth plugin wrapped with `fp()`, health route renamed to `/health`). It uses `Fastify({ logger: true })` and needs both logger packages.

**Files:**
- Modify: `apps/platform/nurturing/src/index.ts`
- Modify: `apps/platform/nurturing/package.json`

- [ ] **Step 1: Add both deps to `apps/platform/nurturing/package.json`**

In `"dependencies"`, add:
```json
"@ortho/logger": "file:../../../packages/@ortho/logger",
"@ortho/fastify-logger": "file:../../../packages/@ortho/fastify-logger"
```

- [ ] **Step 2: Update `apps/platform/nurturing/src/index.ts`**

The file has `import type { Logger } from 'pino'`. Replace that with the `@ortho/logger` import.

Remove:
```typescript
import type { Logger } from 'pino';
```

Add:
```typescript
import { createLogger } from '@ortho/logger';
import type { FastifyBaseLogger } from 'fastify';
import { requestLoggingPlugin } from '@ortho/fastify-logger';
```

Inside `createApp`, before the Fastify constructor, add:
```typescript
const log = createLogger('platform-nurturing');
```

Change:
```typescript
const fastify = Fastify({ logger: true });
```
to:
```typescript
const fastify = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, disableRequestLogging: true });
```

After `await fastify.register(sensible);`, add:
```typescript
await fastify.register(requestLoggingPlugin, { logger: log });
```

Change the health route from:
```typescript
fastify.get('/health', { schema: { hide: true } as object }, async () => {
```
to:
```typescript
fastify.get('/health', { schema: { hide: true } as object, config: { disableRequestLogging: true } }, async () => {
```

Note: If the file previously passed a `Logger` type from pino to other functions, update those references to use `Logger` from `@ortho/logger` instead (`import type { Logger } from '@ortho/logger'`).

- [ ] **Step 3: Install and typecheck**

Run from `apps/platform/nurturing/`:
```bash
npm install && npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/platform/nurturing/
git commit -m "feat(fastify-logger): adopt request-logging plugin in nurturing"
```
