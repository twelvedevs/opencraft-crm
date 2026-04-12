# ADR: @ortho/openapi — Shared OpenAPI/Swagger Plugin

**Date:** 2026-04-12
**Status:** Accepted
**Package:** `packages/@ortho/openapi`

---

## Context

Ortho CRM has 19 backend services (12 platform + 7 CRM, excluding CRM API Gateway). Each service exposes a Fastify REST API but has no machine-readable API documentation. Developers rely on reading route source code to understand available endpoints, request/response shapes, and authentication requirements.

Interactive API docs (Swagger UI) would let developers explore and test endpoints directly from the browser. A shared plugin avoids duplicating `@fastify/swagger` + `@fastify/swagger-ui` configuration across 19 services.

---

## Decision

Provide `@ortho/openapi` — a Fastify plugin that wraps `@fastify/swagger` and `@fastify/swagger-ui` with Ortho-standard defaults. Each service registers it once before its route plugins. In production (`NODE_ENV=production`) the plugin is a no-op.

---

## API

### `openapiPlugin`

Fastify plugin (wrapped with `fastify-plugin` to avoid encapsulation). Registered per-service with service-specific metadata.

```ts
import { openapiPlugin } from '@ortho/openapi';

await app.register(openapiPlugin, {
  title: 'Automation Engine',
  description: 'Event-driven workflow runtime',
  tags: [
    { name: 'Rules', description: 'Automation rule management' },
    { name: 'Executions', description: 'Execution history' },
  ],
});
```

**Options:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | `string` | Yes | Service name shown in Swagger UI |
| `description` | `string` | No | One-line service description |
| `version` | `string` | No | API version (default `"1.0.0"`) |
| `tags` | `Array<{ name, description? }>` | No | Route groupings for the spec |

**Endpoints registered (non-production only):**

| Path | Purpose |
|------|---------|
| `/docs` | Swagger UI (interactive HTML) |
| `/docs/json` | OpenAPI 3.0 spec (JSON, via `@fastify/swagger-ui`) |
| `/openapi.json` | OpenAPI 3.0 spec (JSON, custom convenience route) |

**Security:** All specs include a `BearerAuth` (JWT) security scheme applied globally.

---

## Route Annotation Pattern

Routes use TypeBox `schema` objects already present in most handlers. Only `tags` and `summary` are added:

```ts
fastify.get('/rules/:id', {
  schema: {
    tags: ['Rules'],
    summary: 'Get rule by ID',
    params: Type.Object({ id: Type.String() }),
    response: { 200: RuleSchema },
  },
}, handler);
```

Health/readiness routes are hidden from the spec:

```ts
app.get('/health', { schema: { hide: true } }, async () => ({ ok: true }));
```

---

## Services Covered

All 19 backend services register the plugin:

| Layer | Services |
|-------|----------|
| Platform (12) | automation, nurturing, notification, messaging, email, template, audience, ai, analytics, integration-hub, identity, media |
| CRM (7) | lead, pipeline, conversation, campaign, referral, reporting, import |

CRM API Gateway is excluded (it proxies requests, doesn't define its own domain routes).

---

## Dependencies

```
@ortho/openapi
├── @fastify/swagger ^9
├── @fastify/swagger-ui ^5
└── fastify-plugin ^5
peer: fastify ^5
```

Each service references the package via `"@ortho/openapi": "file:../../../packages/@ortho/openapi"`.

---

## Constraints and Gotchas

- **Register before routes:** The plugin must be registered before route plugins so swagger can discover all routes during `app.ready()`.
- **Production no-op:** When `NODE_ENV=production`, the plugin returns immediately — no swagger dependencies are loaded, no routes are registered.
- **TypeScript `as object` cast:** Services that don't directly depend on `@fastify/swagger` lack its type augmentation for `FastifySchema` (which adds `tags`, `summary`, `hide`). The `as object` cast on schema literals works around this without adding `@fastify/swagger` as a direct dependency to every service.
- **No runtime tests per service:** Only the `@ortho/openapi` package itself has tests (6 tests covering UI serving, spec generation, security scheme, tags, and production no-op). Service-level verification is via `npm run typecheck`.

---

## Consequences

**Good:**
- Every service gets interactive API docs at `/docs` with zero boilerplate beyond a single `register()` call and per-route `tags`/`summary`.
- Existing TypeBox schemas automatically generate request/response documentation — no separate spec file to maintain.
- Production builds have zero overhead (plugin is a no-op).

**Watch out for:**
- New routes must include `tags` and `summary` in their schema or they appear untagged in the spec.
- New services must register the plugin before their route plugins.
- The `@ortho/openapi` package must be built (`npm run build`) before services can import it via the `file:` dependency link.
