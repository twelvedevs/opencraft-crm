# OpenAPI / Swagger Support — Design

**Date:** 2026-04-11
**Status:** Approved
**Scope:** Swagger/OpenAPI 3.0 documentation for all 19 backend services (12 platform + 7 CRM); CRM API Gateway excluded

---

## 1. Overview

Add interactive OpenAPI 3.0 documentation to every backend service via a shared Fastify plugin. Docs are available in local development and staging environments; production is unaffected.

**Goals:**
- Developer ergonomics: explore service APIs without reading source
- Live request execution from the browser (JWT-authenticated)
- Zero production overhead — plugin is a no-op when `NODE_ENV=production`
- Single source of truth for Swagger config across all services

**Non-goals:** CI spec validation, client SDK generation, mock server, spec versioning, unified aggregated portal.

---

## 2. Shared Plugin — `@ortho/openapi`

### 2.1 Location

```
packages/@ortho/openapi/
├── src/
│   └── index.ts
├── package.json
└── tsconfig.json
```

Follows the same pattern as `@ortho/logger` and `@ortho/auth-middleware`.

### 2.2 Plugin API

```ts
interface OpenApiPluginOptions {
  title: string;         // service display name, e.g. "Automation Engine"
  description?: string;  // one-line service description
  version?: string;      // defaults to "1.0.0"
  tags?: Array<{ name: string; description?: string }>;
}

export const openapiPlugin: FastifyPluginAsync<OpenApiPluginOptions>
```

### 2.3 Behavior

**Production (`NODE_ENV === 'production'`):** registers nothing and returns immediately. Zero cost, no routes added.

**Non-production:** registers:
- `@fastify/swagger@^9` — generates OpenAPI 3.0 spec, served at `GET /openapi.json`
- `@fastify/swagger-ui@^5` — interactive UI served at `GET /docs`

**Security scheme:** one global scheme configured — `BearerAuth` (`http` / `bearer` / `JWT`). Applied to all routes so the Authorize button appears throughout the UI. Developers paste a JWT obtained from the Identity Service.

**`/healthz` exclusion:** the healthcheck route in each service's `index.ts` is annotated with `{ schema: { hide: true } }` so it does not appear in the generated spec.

---

## 3. Route Annotations

### 3.1 What gets added

Every route schema receives two new fields:

| Field | Purpose | Example |
|-------|---------|---------|
| `tags` | Groups routes in the UI sidebar | `['Rules']` |
| `summary` | Short label for the endpoint | `'Get rule by ID'` |

```ts
fastify.get('/rules/:id', {
  schema: {
    tags: ['Rules'],
    summary: 'Get rule by ID',
    params: Type.Object({ id: Type.String() }),
    response: { 200: RuleSchema, 404: ErrorSchema },
  },
  // ...
})
```

### 3.2 What does not get added

- `description` on routes — summary is sufficient; detailed design context belongs in `docs/memories/`
- TypeBox property-level `description` fields — property names and types are self-explanatory
- No changes to existing TypeBox schema shapes

### 3.3 `Type.Any()` fields

Several routes use `Type.Any()` for complex nested structures (`action_tree`, `condition`, `active_hours`). These render as `{}` in the OpenAPI spec — valid but uninformative. Tightening those schemas is out of scope for this work.

---

## 4. Per-Service Integration

### 4.1 Service scope

| Layer | Services (19 total) |
|-------|---|
| Platform (12) | messaging, email, notification, template, nurturing, automation, audience, ai, analytics, integration-hub, identity, media |
| CRM (7) | lead, pipeline, conversation, campaign, referral, reporting, import |

**CRM API Gateway is excluded** — it is a transparent reverse proxy with no TypeBox route schemas.

### 4.2 Registration pattern

In each service's `index.ts`, register `openapiPlugin` before route registrations:

```ts
import { openapiPlugin } from '@ortho/openapi';

const fastify = Fastify({ logger: true });

await fastify.register(openapiPlugin, {
  title: 'Automation Engine',
  description: 'Event-driven workflow runtime',
  tags: [
    { name: 'Rules', description: 'Automation rule management' },
    { name: 'Executions', description: 'Execution history and dry-run' },
  ],
});

fastify.get('/healthz', { schema: { hide: true } }, async () => ({ ok: true }));

await fastify.register(rulesRoutes, { db, jobCanceller });
await fastify.register(executionRoutes, { db });
```

### 4.3 Dependency

Each service's `package.json` adds:

```json
"@ortho/openapi": "file:../../../packages/@ortho/openapi"
```

Same `file:` reference pattern used by `@ortho/logger` and `@ortho/auth-middleware`.

---

## 5. Services with Worker Processes

Campaign, nurturing, and email services run a BullMQ worker process alongside the HTTP server. The `openapiPlugin` registers only on the Fastify instance. Worker process files are not modified.

---

## 6. Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@fastify/swagger` | `^9` | OpenAPI 3.0 spec generation from Fastify route schemas |
| `@fastify/swagger-ui` | `^5` | Swagger UI served at `/docs` |

Both are devDependencies in `@ortho/openapi/package.json`. Services inherit them transitively; no direct install in service packages required.

---

## 7. Endpoints Added Per Service

| Path | Description |
|------|-------------|
| `GET /docs` | Swagger UI (HTML) — non-production only |
| `GET /docs/static/*` | Swagger UI static assets |
| `GET /openapi.json` | Raw OpenAPI 3.0 spec |
