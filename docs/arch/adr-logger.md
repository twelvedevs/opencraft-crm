# ADR: @ortho/logger — Structured Logging Package

**Date:** 2026-03-30
**Status:** Accepted
**Package:** `packages/@ortho/logger`

---

## Context

All backend services in the Ortho monorepo need consistent structured logging that:

- Emits JSON lines compatible with Datadog Log Management
- Carries a `service` field on every line so logs are filterable by service in Datadog
- Emits both `level` and `status` fields so Datadog's log severity pipeline works without a custom parsing rule
- Supports runtime log-level control via environment variable
- Requires zero configuration per-service beyond providing a service name

Pino was chosen as the underlying library for its best-in-class throughput and built-in JSON serialisation.

---

## Decision

Provide a thin wrapper around Pino (`packages/@ortho/logger`) that applies the Datadog-compatible configuration once. Services import `createLogger` or the pre-built `logger` singleton — they never configure Pino directly.

---

## API

### `createLogger(service: string): Logger`

Creates a new Pino logger bound to the given service name. Every log line will include `{ "service": "<name>", "level": "...", "status": "...", "time": "..." }`.

The log level is controlled by the `LOG_LEVEL` environment variable (default: `"info"`).

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `service` | `string` | Yes | Value written to the `service` field on every log line |

**Returns:** `pino.Logger` — the full Pino Logger interface (child loggers, bindings, etc.)

---

### `logger`

A module-level singleton created with `createLogger('ortho')`. Useful for quick scripts or shared utilities where setting up a per-service logger is unnecessary.

---

### `Logger` (re-export)

The `pino.Logger` type, re-exported for use in type signatures across the monorepo without a direct Pino dependency.

```ts
import type { Logger } from '@ortho/logger';
```

---

## Configuration

| Environment Variable | Default | Description |
|----------------------|---------|-------------|
| `LOG_LEVEL` | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` |

---

## JSON Output Format

Every log line includes at minimum:

```json
{
  "level": "info",
  "status": "info",
  "time": "2026-03-30T12:00:00.000Z",
  "service": "notification",
  "msg": "server started"
}
```

- `level` — standard Pino label string (expected by many log shippers)
- `status` — duplicate of `level`; Datadog APM uses this field for severity colouring
- `time` — ISO 8601 string (`pino.stdTimeFunctions.isoTime`)
- `service` — the value passed to `createLogger`

Arbitrary fields passed to the log call are serialised alongside these:

```json
{
  "level": "info",
  "status": "info",
  "time": "2026-03-30T12:00:00.003Z",
  "service": "lead",
  "msg": "lead created",
  "leadId": "lead-abc-123",
  "locationId": "loc-7"
}
```

---

## Examples

### 1. Service-level logger (recommended pattern)

Every service creates one logger at module initialisation time and passes it (or child loggers) to downstream layers.

```ts
// apps/platform/notification/src/index.ts
import Fastify from 'fastify';
import { createLogger } from '@ortho/logger';

const log = createLogger('notification');

const app = Fastify({ logger: false }); // disable Fastify's built-in logger

app.get('/healthz', async () => {
  log.debug('health check');
  return { ok: true };
});

app.listen({ port: 3000 }, (err) => {
  if (err) {
    log.fatal({ err }, 'failed to start server');
    process.exit(1);
  }
  log.info('server listening on :3000');
});
```

### 2. Child loggers for request-scoped context

Use `log.child()` to bind request-level fields without repeating them on every call.

```ts
// apps/crm/lead/src/routes/leads.ts
import type { FastifyRequest, FastifyReply } from 'fastify';
import { createLogger } from '@ortho/logger';

const log = createLogger('lead');

export async function createLeadHandler(req: FastifyRequest, reply: FastifyReply) {
  const reqLog = log.child({ requestId: req.id, locationId: req.headers['x-location-id'] });

  reqLog.info('creating lead');

  try {
    const lead = await leadService.create(req.body);
    reqLog.info({ leadId: lead.id }, 'lead created');
    return reply.status(201).send(lead);
  } catch (err) {
    reqLog.error({ err }, 'lead creation failed');
    return reply.status(500).send({ error: 'internal_error' });
  }
}
```

### 3. Logging errors with full stack

Pass the error object under the `err` key — Pino serialises it with `message` and `stack`.

```ts
import { createLogger } from '@ortho/logger';

const log = createLogger('email');

try {
  await sendGridClient.send(payload);
} catch (err) {
  log.error({ err, to: payload.to }, 'SendGrid delivery failed');
}
```

### 4. Adjusting log level at runtime (staging/debug)

```bash
LOG_LEVEL=debug node dist/index.js
```

All `log.debug(...)` calls that are normally suppressed will appear in output.

### 5. Shared utility using the singleton

```ts
// packages/@ortho/db/src/pool.ts
import { logger } from '@ortho/logger';

export function createPool(url: string) {
  logger.info({ url: redactPassword(url) }, 'creating DB connection pool');
  // ...
}
```

---

## Consequences

**Good:**
- Zero per-service Pino configuration. All Datadog field requirements are handled once in the package.
- `LOG_LEVEL` can be changed per environment (ECS task definition env) without code changes.
- Child loggers allow per-request correlation fields without polluting the service-level logger.

**Watch out for:**
- Do not call `pino()` directly in service code — this bypasses the `status` field formatter and breaks Datadog severity colouring.
- Do not stringify objects manually before passing to Pino — pass them as a binding object so Pino serialises them correctly.
- The `time` field is ISO 8601, not epoch milliseconds. Datadog's default log parser handles ISO 8601. Do not override `timestamp` in service code.
