# CRM API Gateway — Design Spec

**Date:** 2026-03-25
**Status:** Draft
**Scope:** Product-layer CRM API Gateway — reverse proxy, JWT + API key auth, tiered rate limiting, SSE proxy, pre-forward enrichment for pipeline transitions

---

## 1. Overview

The CRM API Gateway (`apps/crm/api-gateway`) is the **single public-facing entry point** for the React SPA and future EHR integration. It is a Fastify reverse proxy — no database schema, no EventBridge subscriptions, no domain logic. Every external HTTP request to a CRM product service routes through it.

**Core responsibilities:**
- Authenticate requests (JWT for browser users, API keys for EHR and internal services)
- Enforce tiered rate limiting (IP / per-user / per-key)
- Proxy requests to the eight CRM product services under `/v1/*`
- Stream SSE from the Notification Service to the browser without buffering
- Enforce two gateway-layer RBAC rules before forwarding (pipeline override flag, channel resolution for `/convert`)
- Inject distributed tracing headers and normalize gateway-level errors

**Out of scope:**
- Request aggregation / BFF fan-out — each service's API surface is authoritative; the frontend makes separate calls
- Proxying platform services (Template, Nurturing, Automation, Audience, Integration Hub, AI, Analytics, Messaging, Email) — these are called directly by `@platform/*` UI components or by other services
- Proxying Identity Service — browser calls it directly for login, refresh, JWKS, and user management
- Proxying Media Service — browser uploads directly via presigned PUT from Media Service

---

## 2. Architecture

```
Browser (React SPA)          EHR (future)         Internal Services
   JWT Bearer                 ak_ Bearer          (Automation Engine, etc.)
        │                         │                        │
        └─────────────────────────┴────────────────────────┘
                                  │
                   ┌──────────────▼──────────────┐
                   │       CRM API Gateway        │
                   │    apps/crm/api-gateway      │
                   │                              │
                   │  plugins/  (global)          │
                   │    request-id                │
                   │    auth                      │
                   │    rate-limit                │
                   │    error-handler             │
                   │                              │
                   │  routes/  (scoped prefixes)  │
                   │    leads         /v1/leads   │
                   │    pipeline      /v1/pipeline│
                   │    conversations /v1/convs   │
                   │    campaigns     /v1/campaigns│
                   │    referrals     /v1/referrals│
                   │    reports       /v1/reports  │
                   │    imports       /v1/imports  │
                   │    notifications /v1/notifs   │
                   └──────────────────────────────┘
                          │              │
             VPC-internal │              │ VPC-internal
                          ▼              ▼
                    Product services   Identity Service
                   (Lead, Pipeline,   (API key validation —
                    Conversation,      VPC-only endpoint)
                    Campaign, etc.)
```

**Key properties:**
- No DB, no migrations, no BullMQ, no EventBridge subscriptions
- All upstream service URLs are static env vars — no service discovery
- Pure pass-through: downstream errors are forwarded as-is (status code + body unchanged)
- The gateway is the only service in the CRM product layer that has no `migrations/` directory

---

## 3. Authentication

Three authentication paths, detected in order by the `auth` plugin on every request.

### 3.1 Public (no auth)

Applied to three specific routes in the `referrals` plugin. No JWT check. Rate-limited by IP only.

| Route | Purpose |
|---|---|
| `GET /v1/referrals/r/:code` | Click redirect (302) — practice website referral link |
| `GET /v1/referrals/links/:code` | Link info for the embeddable form widget |
| `GET /v1/referrals/portal/:token` | Doctor referral portal (long-lived token auth in Referral Service) |

### 3.2 JWT (browser users)

`Authorization: Bearer <jwt>` where the token does NOT begin with `ak_`.

`@ortho/auth-middleware` verifies the RS256 signature against the Identity Service JWKS endpoint (cached at startup, TTL controlled by `JWKS_CACHE_TTL_MS`; re-fetched immediately on unknown `kid` with exponential back-off). Extracts `{ sub, role, locations, must_change_password }` claims into request context.

The JWT is forwarded unchanged in the `Authorization` header — downstream services using `@ortho/auth-middleware` re-verify independently. The gateway also injects extracted claims as `X-User-*` headers for downstream services that need them without re-parsing (see Section 6).

`must_change_password: true` — `@ortho/auth-middleware` enforces this server-side: all routes return `403 { "error": "password_change_required" }` except the Identity Service endpoints (which are not proxied here). No additional gateway logic needed.

### 3.3 API Key (EHR + internal services)

`Authorization: Bearer ak_<hex>` — detected by the `ak_` prefix.

**Validation flow:**
1. Check in-process LRU cache (500 entries, `API_KEY_CACHE_TTL_MS` TTL, default 60s) keyed on the raw key string
2. On cache miss: call `POST /identity/api-keys/validate` (VPC-only) with `X-Internal-Secret: <INTERNAL_API_SECRET>` and body `{ "key": "<raw key>" }`. Response: `{ "permissions": [...] }` or `401`
3. Cache the validated response. Update `last_used_at` on cache misses only (not on every API call)
4. On cache hit or validated miss: store `{ keyId, permissions }` in request context
5. Forward the original `Authorization` header to the downstream service unchanged

For API key requests, `X-User-Id` / `X-User-Role` / `X-User-Locations` headers are omitted — downstream services receive the raw `ak_` Authorization header only.

---

## 4. RBAC Enforcement

The gateway enforces RBAC above `@ortho/auth-middleware` for exactly two cross-service flows. All other RBAC is delegated to downstream services.

### 4.1 Pipeline override flag

**Route:** `POST /v1/pipeline/transitions` with `override: true` in the request body.

The gateway reads the JWT `role` claim before forwarding. Only `call_center_manager`, `marketing_manager`, and `super_admin` may set `override: true`. If `role === 'call_center_agent'` and `override: true` is present, the gateway returns `403 { "error": "forbidden" }` without forwarding. `super_admin` bypasses all gateway permission checks unconditionally.

Pipeline Engine trusts the forwarded `override` and `triggered_by` fields — it does not re-check role.

### 4.2 Channel resolution for pipeline convert

**Route:** `POST /v1/pipeline/convert`

Before forwarding, the gateway calls `GET /leads/:id` on the Lead Service (VPC-internal, `Authorization: Bearer <LEAD_SERVICE_API_KEY>`) to resolve the lead's immutable attribution channel. The resolved `channel` string is injected into the forwarded request body. Pipeline Engine requires a valid `channel` value on this endpoint and returns `400` if absent.

If the Lead Service returns `404`, the gateway returns `404 { "error": "lead_not_found" }` without forwarding to Pipeline Engine.

---

## 5. Rate Limiting

Implemented via `@fastify/rate-limit` as a global plugin. The rate-limit plugin reads the auth context populated by the `auth` plugin to select the key generator.

| Tier | Applied to | Key | Limit |
|---|---|---|---|
| Public | Unauthenticated routes | IP address | 60 req/min |
| User | JWT-authenticated routes | `sub` claim | 300 req/min |
| API key | `ak_`-authenticated routes | Key ID | 600 req/min |

Rate limit exceeded: `429 { "error": "rate_limit_exceeded" }` with a `Retry-After` header.

No per-route limit overrides at launch. All routes within a tier share the same limit. Per-route tuning (e.g., bulk SMS) can be added to the relevant route plugin if needed.

---

## 6. Request/Response Handling

### 6.1 Headers injected on every forwarded request

| Header | Value | Notes |
|---|---|---|
| `X-Request-ID` | UUID v4 | Generated if not already present in incoming request |
| `X-Forwarded-For` | Client IP | Passed through for downstream logging |
| `X-User-Id` | JWT `sub` claim | JWT routes only — omitted for API key routes |
| `X-User-Role` | JWT `role` claim | JWT routes only |
| `X-User-Locations` | JWT `locations` as comma-separated string | JWT routes only |

The original `Authorization` header is always forwarded unchanged.

### 6.2 Gateway-generated error responses

Downstream errors pass through as-is (status code + body unchanged). The gateway generates its own errors only for the conditions below. Shape matches the `{ "error": "<message>" }` convention used by all services.

| Condition | Status | Body |
|---|---|---|
| Missing or invalid JWT | 401 | `{ "error": "unauthorized" }` |
| Invalid or revoked API key | 401 | `{ "error": "unauthorized" }` |
| `override: true` RBAC violation | 403 | `{ "error": "forbidden" }` |
| Rate limit exceeded | 429 | `{ "error": "rate_limit_exceeded" }` |
| Lead not found during channel resolution | 404 | `{ "error": "lead_not_found" }` |
| Upstream service unreachable or timeout | 502 | `{ "error": "upstream_unavailable" }` |

### 6.3 Upstream timeout

All proxied requests use a 30s upstream timeout, except the SSE stream (no timeout — connection is long-lived). On timeout, gateway returns `502 { "error": "upstream_unavailable" }`.

### 6.4 Logging

Every request logged via `@ortho/logger` (Pino, Datadog-compatible) with: `request_id`, `method`, `path`, `status_code`, `duration_ms`, `user_id` (JWT routes), `key_id` (API key routes), `upstream_service`. No request or response body logging.

---

## 7. SSE Proxy

```
GET /v1/notifications/stream
```

JWT auth required. The gateway streams the Notification Service response directly to the client without buffering.

**Implementation:** `@fastify/reply-from` with `replyOptions` configured to pipe the upstream response body. No request timeout on this route.

**Headers passed client → upstream:**
- `Last-Event-ID` — required for reconnect replay from the correct sequence position

**Headers passed upstream → client (and added by gateway):**
- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `X-Accel-Buffering: no` — added by gateway to suppress nginx / ALB buffering

All other Notification Service routes (`GET /v1/notifications`, `POST /v1/notifications/:id/read`, `POST /v1/notifications/read-all`) are standard buffered proxy calls with JWT auth.

---

## 8. Internal Code Structure

```
apps/crm/api-gateway/
├── src/
│   ├── plugins/
│   │   ├── auth.ts              # JWT + API key detection, validation, context population
│   │   ├── rate-limit.ts        # @fastify/rate-limit, tiered key generators
│   │   ├── request-id.ts        # X-Request-ID injection
│   │   └── error-handler.ts     # gateway-level error shape, 502 on upstream failure
│   ├── routes/                  # one Fastify plugin per downstream service
│   │   ├── leads.ts             # /v1/leads/*
│   │   ├── pipeline.ts          # /v1/pipeline/* (override RBAC + channel enrichment)
│   │   ├── conversations.ts     # /v1/conversations/*
│   │   ├── campaigns.ts         # /v1/campaigns/*
│   │   ├── referrals.ts         # /v1/referrals/* (public + JWT routes)
│   │   ├── reports.ts           # /v1/reports/*
│   │   ├── imports.ts           # /v1/imports/*
│   │   └── notifications.ts     # /v1/notifications/* (SSE + standard routes)
│   ├── lib/
│   │   ├── api-key-cache.ts     # LRU (500 entries, configurable TTL) for validated ak_ keys
│   │   └── channel-resolver.ts  # calls Lead Service, extracts channel for /convert
│   └── index.ts                 # registers global plugins then route plugins
├── test/
│   ├── auth.test.ts             # JWT valid/invalid/expired, ak_ valid/invalid/cached
│   ├── pipeline.test.ts         # override RBAC enforcement, channel resolution flow
│   ├── referrals.test.ts        # public route bypass of auth + rate limiting by IP
│   └── rate-limit.test.ts       # per-tier limit enforcement
├── Dockerfile
├── package.json
└── tsconfig.json
```

**Plugin registration order in `index.ts`:**
1. `request-id` — must run first so all subsequent plugins see the ID
2. `auth` — populates request context before rate-limit reads it
3. `rate-limit` — reads auth context to select key generator
4. `error-handler` — catches errors thrown by route plugins
5. Route plugins — each scoped to their `/v1/<service>` prefix

---

## 9. Environment Variables

| Env var | Purpose | Default |
|---|---|---|
| `LEAD_SERVICE_URL` | Lead Service base URL (VPC-internal) | — |
| `PIPELINE_SERVICE_URL` | Pipeline Engine base URL | — |
| `CONVERSATION_SERVICE_URL` | Conversation Service base URL | — |
| `CAMPAIGN_SERVICE_URL` | Campaign Service base URL | — |
| `REFERRAL_SERVICE_URL` | Referral Service base URL | — |
| `REPORTING_SERVICE_URL` | Reporting Service base URL | — |
| `IMPORT_SERVICE_URL` | Data Import Service base URL | — |
| `NOTIFICATION_SERVICE_URL` | Notification Service base URL | — |
| `IDENTITY_SERVICE_URL` | Identity Service base URL (VPC-internal) | — |
| `LEAD_SERVICE_API_KEY` | `ak_`-prefixed key for channel resolution calls to Lead Service | — |
| `INTERNAL_API_SECRET` | Shared secret for `POST /identity/api-keys/validate` | — |
| `JWKS_CACHE_TTL_MS` | JWKS cache TTL | `300000` |
| `API_KEY_CACHE_TTL_MS` | API key validation cache TTL | `60000` |
| `PORT` | Gateway listen port | `3000` |
| `LOG_LEVEL` | Pino log level | `info` |

All `*_URL` and `*_KEY` / `*_SECRET` values are required at startup — the service fails fast on missing config.

---

## 10. API Versioning

All proxied routes are served under the `/v1/` prefix. The gateway strips `/v1` before forwarding to upstream services — downstream services have no version prefix in their own route definitions.

When a breaking API change is required, a `/v2/` route plugin is added alongside `/v1/` in the relevant service's route file. Both versions can be live simultaneously during migration. Upstream services expose the new behaviour on a separate path; the gateway maps `/v2/<route>` to the new upstream path.

No version negotiation via headers — URL path versioning only.
