# `@ortho/fastify-logger` — Design Spec

**Date:** 2026-04-16
**Status:** Approved

## Overview

A new shared package `@ortho/fastify-logger` that provides a Fastify 5 request-logging plugin. The plugin handles structured request/response/error logging for all Fastify services in the monorepo, replacing Fastify's built-in request logging with a consistent, controlled alternative backed by `@ortho/logger`.

Scope: package creation + adoption across all 19 Fastify services. Prometheus metrics and correlation-id integration are out of scope for this iteration.

---

## Package Structure

```
packages/@ortho/fastify-logger/
├── package.json
├── tsconfig.json
└── src/
    └── index.ts
```

`index.ts` exports:
- `requestLoggingPlugin` — `fp()`-wrapped Fastify plugin
- `RequestLoggingPluginOptions` — TypeScript options interface

**`package.json` dependencies:**
- `dependencies`: `fastify-plugin ^5.0.0`, `@ortho/logger: *`
- `peerDependencies`: `fastify ^5.0.0`
- `devDependencies`: `fastify ^5.0.0`, `typescript ^5.0.0`, `@types/node ^22.0.0`

---

## Plugin API

```ts
interface RequestLoggingPluginOptions {
  logger: Logger;        // Logger instance from @ortho/logger — injected, not created internally
  maxBodySize?: number;  // body truncation ceiling in bytes, default 10 240 (10 KB)
}
```

Registration in each service:

```ts
import { requestLoggingPlugin } from '@ortho/fastify-logger';

const app = Fastify({
  loggerInstance: log as unknown as FastifyBaseLogger,
  disableRequestLogging: true,  // prevents Fastify's built-in duplicate request logs
});

app.register(requestLoggingPlugin, { logger: log });
```

The same `log` instance (created via `createLogger('service-name')` from `@ortho/logger`) is passed to both the Fastify constructor and the plugin. One pino instance per service.

---

## Plugin Behavior

### TypeScript augmentations

```ts
declare module 'fastify' {
  interface FastifyContextConfig {
    disableRequestLogging?: boolean;
  }
  interface FastifyRequest {
    _loggingStartTime?: number;
  }
}
```

`_loggingStartTime` is registered via `decorateRequest` so Fastify's schema validator does not complain.

### `onRequest` hook

Skipped if `request.routeOptions?.config.disableRequestLogging` is `true`.

Logs at `info` level:

```json
{
  "msg": "incoming request",
  "method": "POST",
  "url": "/leads",
  "userAgent": "...",
  "timestamp": "2026-04-16T10:00:00.000Z"
}
```

Sets `request._loggingStartTime = Date.now()` for duration tracking.

### `onResponse` hook

Skipped if `disableRequestLogging` is `true`.

Logs at `info` level:

```json
{
  "msg": "outgoing response",
  "statusCode": 200,
  "durationMs": 42,
  "responseSize": 512
}
```

`responseSize` is read from the `content-length` response header; omitted if not present.

For responses with `statusCode >= 400`, additionally appends `requestBody` (truncated to `maxBodySize`).

### `onError` hook

**Always fires**, regardless of `disableRequestLogging`. Errors on `/health` and other opted-out routes must remain visible for operational debugging.

Logs at `error` level:

```json
{
  "msg": "request error",
  "error": { "name": "Error", "message": "...", "stack": "..." },
  "method": "GET",
  "url": "/leads/123",
  "statusCode": 500,
  "durationMs": 12,
  "requestBody": "..."
}
```

`requestBody` is included only if `request.body` is defined, truncated to `maxBodySize`.

### Body truncation

```ts
function truncateBody(body: unknown, maxSize: number): string
```

Converts to string, checks byte length via `Buffer.byteLength`. If over `maxSize`, slices at `maxSize` bytes and appends ` [truncated: N bytes total]`.

### Per-route opt-out

The `/health` route in every service is marked:

```ts
fastify.get('/health', { config: { disableRequestLogging: true } }, handler);
```

This silences `onRequest` and `onResponse` for health-check noise while still catching errors on that route via `onError`.

---

## Service Adoption

### Group A — already use `loggerInstance: log` (9 services)

pipeline, lead, conversation, reporting, referral, import, identity, media, api-gateway

Changes per service:
1. Add `disableRequestLogging: true` to the Fastify constructor (api-gateway currently has it set to `false`)
2. Add `@ortho/fastify-logger` to `dependencies` in `package.json`
3. Register `requestLoggingPlugin` after other plugins
4. Add `config: { disableRequestLogging: true }` to the `/health` route

### Group B — use `logger: true` or `logger: { level }` (10 services)

notification, nurturing, automation, template, ai, audience, messaging, email, analytics, integration-hub

Additional changes on top of Group A:
1. Add `@ortho/logger` to `dependencies` if not already present
2. Import `createLogger` and construct `const log = createLogger('service-name')` at module level
3. Replace `logger: true` / `logger: { level }` with `loggerInstance: log as unknown as FastifyBaseLogger`

---

## What Is Explicitly Out of Scope

- Correlation-id propagation (`request.correlationId` removed entirely from plugin)
- Prometheus / `prom-client` metrics (separate future package)
- Distributed tracing
- Changes to `@ortho/logger` itself
