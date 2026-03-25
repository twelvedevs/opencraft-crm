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
- Expose a health check endpoint for ECS Fargate

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
                   ┌──────────────▼───────────────────┐
                   │         CRM API Gateway           │
                   │      apps/crm/api-gateway         │
                   │                                   │
                   │  plugins/  (global)               │
                   │    request-id                     │
                   │    auth                           │
                   │    rate-limit                     │
                   │    error-handler                  │
                   │                                   │
                   │  routes/  (scoped prefixes)       │
                   │    leads          /v1/leads       │
                   │    pipeline       /v1/pipeline    │
                   │    conversations  /v1/conversations│
                   │    campaigns      /v1/campaigns   │
                   │    referrals      /v1/referrals   │
                   │    reports        /v1/reports     │
                   │    imports        /v1/imports     │
                   │    notifications  /v1/notifications│
                   └───────────────────────────────────┘
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

**Header stripping:** Before injecting any `X-User-*` or `X-Api-Key-Permissions` headers, the gateway unconditionally strips any incoming `X-User-Id`, `X-User-Role`, `X-User-Locations`, and `X-Api-Key-Permissions` headers from the client request. This prevents clients from spoofing gateway-injected headers.

### 3.1 Public (no auth)

Applied to exactly four routes:
- `GET /health` — ECS Fargate health check (unversioned)
- `GET /v1/referrals/r/:code` — click redirect (302) for practice website referral links
- `GET /v1/referrals/links/:code` — link info for the embeddable form widget
- `GET /v1/referrals/portal/:token` — doctor referral portal (long-lived token auth enforced in Referral Service)

No JWT check. Rate-limited by IP only. `GET /health` is also excluded from rate limiting.

### 3.2 JWT (browser users)

`Authorization: Bearer <jwt>` where the token does NOT begin with `ak_`.

`@ortho/auth-middleware` verifies the RS256 signature against the Identity Service JWKS endpoint (cached at startup, TTL controlled by `JWKS_CACHE_TTL_MS`). On receiving a JWT with an unknown `kid`, the middleware re-fetches the JWKS endpoint immediately — up to 3 retries with exponential back-off capped at 5s per retry. While JWKS is unreachable, requests with an unrecognized `kid` return `401 { "error": "unauthorized" }`. On success, extracts `{ sub, role, locations, must_change_password }` claims into request context.

The JWT is forwarded unchanged in the `Authorization` header — downstream services that use `@ortho/auth-middleware` re-verify independently.

**`must_change_password: true`:** `@ortho/auth-middleware` blocks all routes and returns `403 { "error": "password_change_required" }`. The only exempted routes in other specs (`PUT /identity/me/password`, `GET /identity/me`, `DELETE /identity/session`) are Identity Service endpoints — not proxied by this gateway. Therefore every route the gateway handles is blocked without exception when `must_change_password: true`.

### 3.3 API Key (EHR + internal services)

`Authorization: Bearer ak_<hex>` — detected by the `ak_` prefix.

**Validation flow:**
1. Compute `key_hash = SHA256(raw_key)`. Check in-process LRU cache (500 entries, `API_KEY_CACHE_TTL_MS` TTL, default 60s) keyed on `key_hash`.
2. On cache miss: call `POST /identity/api-keys/validate` (VPC-only) with `X-Internal-Secret: <INTERNAL_API_SECRET>` and body `{ "key": "<raw key>" }`. Response: `{ "permissions": [...] }` or `401`.
3. On Identity Service unreachable (timeout or 5xx): fail closed — return `503 { "error": "auth_unavailable" }` to the caller. Never fail open.
4. Cache the validated `{ permissions }` keyed on `key_hash`. Update `last_used_at` on cache misses only.
5. Store `{ keyHash, permissions }` in request context. `keyHash` is used as the rate limit key and the log field.

**Downstream forwarding for API key requests:** The gateway strips the `Authorization: Bearer ak_<...>` header and does NOT forward it. Instead it injects `X-Api-Key-Permissions: <comma-separated permissions>` into the forwarded request. Downstream product services are VPC-internal and rely on the gateway as the auth boundary — they do not independently validate `ak_` keys.

`X-User-Id`, `X-User-Role`, and `X-User-Locations` are omitted for API key requests.

**`triggered_by` on pipeline routes for API key callers:** Internal services (Automation Engine, Data Import Service) that call pipeline endpoints via API key are responsible for including `triggered_by` in the request body. The gateway forwards the body field as-is. No gateway injection of `triggered_by` for API key requests.

---

## 4. RBAC Enforcement

The gateway enforces RBAC above `@ortho/auth-middleware` for exactly two cross-service flows. All other RBAC is delegated to downstream services.

### 4.1 Pipeline override flag

**Route:** `POST /v1/pipeline/transitions` with `override: true` in the request body.

The gateway reads the JWT `role` claim before forwarding. Permitted roles: `call_center_manager`, `marketing_manager`, `super_admin`. Blocked roles: `call_center_agent`, `marketing_staff`. If a blocked role sends `override: true`, the gateway returns `403 { "error": "forbidden" }` without forwarding. `super_admin` is included in the permitted list and is allowed to set `override: true` — this is the extent of `super_admin`'s special treatment for this check only.

`override: false` and absent `override` field are treated identically — no RBAC check is triggered; the request is forwarded as-is.

Pipeline Engine trusts the forwarded `override` and `triggered_by` fields — it does not re-check role.

### 4.2 Channel resolution for pipeline convert

**Route:** `POST /v1/pipeline/convert`

The request body includes a `lead_id` field identifying the lead being converted. Before forwarding, the gateway calls `GET /leads/:lead_id` on the Lead Service (VPC-internal, `Authorization: Bearer <LEAD_SERVICE_API_KEY>`) to resolve the lead's immutable attribution channel. The gateway always overwrites any client-supplied `channel` field in the request body with the gateway-resolved value, preventing spoofing. Pipeline Engine requires a valid `channel` value and returns `400` if absent.

**Failure cases:**
- Lead Service returns `404` → gateway returns `404 { "error": "lead_not_found" }` without forwarding
- Lead Service unreachable or returns `5xx` → gateway returns `502 { "error": "upstream_unavailable" }` without forwarding
- Lead Service returns `200` but `channel` is `null`, absent, or not a member of the valid enum → gateway returns `422 { "error": "channel_resolution_failed" }` without forwarding. Valid `channel` values: `google_ads | facebook | website | referral_patient | referral_doctor | call_tracking | walk_in | chat | google_business | import | unknown`

---

## 5. Rate Limiting

Implemented via `@fastify/rate-limit` as a global plugin. The rate-limit plugin reads the auth context populated by the `auth` plugin to select the key generator.

| Tier | Applied to | Key | Limit |
|---|---|---|---|
| Public | Unauthenticated routes (excluding `/health`) | IP address (ALB-injected rightmost value in `X-Forwarded-For`) | 60 req/min |
| User | JWT-authenticated routes | `sub` claim | 300 req/min |
| API key | `ak_`-authenticated routes | `keyHash` (SHA256 of raw key) | 600 req/min |

Rate limit exceeded: `429 { "error": "rate_limit_exceeded" }` with a `Retry-After` header.

No per-route limit overrides at launch. All routes within a tier share the same limit. Per-route tuning (e.g., bulk SMS) can be added to the relevant route plugin if needed.

---

## 6. Request/Response Handling

### 6.1 Headers injected on every forwarded request

The gateway strips any client-supplied `X-User-*` and `X-Api-Key-Permissions` headers before injection (see Section 3).

| Header | Value | Notes |
|---|---|---|
| `X-Request-ID` | UUID v4 | Generated if not present in incoming request; the incoming value is accepted and forwarded if already present (for tracing continuity from a trusted upstream) |
| `X-Forwarded-For` | ALB-injected rightmost IP (real client IP) | The gateway uses the rightmost value appended by the ALB as the authoritative client IP. The full original chain is forwarded for downstream logging. Client-supplied `X-Forwarded-For` values are not trusted for rate limiting. |
| `X-User-Id` | JWT `sub` claim | JWT routes only |
| `X-User-Role` | JWT `role` claim | JWT routes only |
| `X-User-Locations` | JWT `locations` as comma-separated string | JWT routes only; **omitted entirely** when `locations[]` is empty (i.e., `marketing_staff`, `marketing_manager`, `super_admin`). Downstream services interpret absence of this header as "all locations" for those roles. |
| `X-Api-Key-Permissions` | Comma-separated permissions from validated key | API key routes only |

The original `Authorization` header is forwarded unchanged on JWT routes. On API key routes, `Authorization` is stripped and not forwarded (replaced by `X-Api-Key-Permissions`).

**Expired vs invalid JWT:** Both return `401 { "error": "unauthorized" }`. The `401` status is the signal for the browser to attempt a token refresh via `POST /identity/session` with the refresh token. No `token_expired` sub-code is surfaced — the frontend handles all `401` responses on authenticated routes as a refresh trigger.

### 6.2 Gateway-generated error responses

Downstream errors pass through as-is (status code + body unchanged). The gateway generates its own errors only for the conditions below. Shape matches the `{ "error": "<message>" }` convention used by all services.

| Condition | Status | Body |
|---|---|---|
| Missing or invalid JWT | 401 | `{ "error": "unauthorized" }` |
| Invalid or revoked API key | 401 | `{ "error": "unauthorized" }` |
| Identity Service unreachable for API key validation | 503 | `{ "error": "auth_unavailable" }` |
| `must_change_password: true` | 403 | `{ "error": "password_change_required" }` |
| `override: true` RBAC violation | 403 | `{ "error": "forbidden" }` |
| Rate limit exceeded | 429 | `{ "error": "rate_limit_exceeded" }` |
| Lead not found during channel resolution | 404 | `{ "error": "lead_not_found" }` |
| Lead channel null/invalid/missing | 422 | `{ "error": "channel_resolution_failed" }` |
| Upstream service unreachable or timeout | 502 | `{ "error": "upstream_unavailable" }` |

### 6.3 Upstream timeout

All proxied requests use a timeout controlled by `UPSTREAM_TIMEOUT_MS` (default 30000ms), except the SSE stream (no timeout — connection is long-lived). On timeout, gateway returns `502 { "error": "upstream_unavailable" }`.

### 6.4 Logging

Every request logged via `@ortho/logger` (Pino, Datadog-compatible) with: `request_id`, `method`, `path`, `status_code`, `duration_ms`, `user_id` (JWT routes), `key_hash` (API key routes — SHA256 of raw key, never the raw key itself), `upstream_service`. No request or response body logging.

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
- `X-Accel-Buffering: no` — added by gateway to suppress nginx / ALB response buffering

**SSE headers:** `@fastify/reply-from` in streaming mode handles `Transfer-Encoding` automatically — the gateway does not manually set or forward `Transfer-Encoding` headers from the upstream. `Connection: keep-alive` is set by the gateway on the client-facing response to maintain the long-lived connection.

**Concurrent SSE connections:** No per-user concurrent connection limit is enforced at v1. Each authenticated SSE request opens one upstream connection. Connection exhaustion monitoring is deferred to post-launch observability.

All other Notification Service routes (`GET /v1/notifications`, `POST /v1/notifications/:id/read`, `POST /v1/notifications/read-all`) are standard buffered proxy calls with JWT auth.

---

## 8. Health Check

```
GET /health
```

No auth, no rate limiting, no `/v1/` prefix. Returns `200 { "status": "ok" }`. Used by ECS Fargate target group health checks.

---

## 9. Referral Route Auth Split

The `referrals` route plugin registers public and JWT-protected routes in the same plugin file using Fastify's scoped plugin pattern. Public routes are registered first with `{ config: { auth: false } }` — the `auth` plugin checks this config flag and skips JWT verification for those routes. All remaining `/v1/referrals/*` routes fall through to the global JWT enforcement.

This keeps the public/JWT split explicit and colocated in one file, with the auth plugin as the single enforcement point.

---

## 10. Internal Code Structure

```
apps/crm/api-gateway/
├── src/
│   ├── plugins/
│   │   ├── auth.ts              # JWT + API key detection, validation, context population; strips incoming X-User-* headers
│   │   ├── rate-limit.ts        # @fastify/rate-limit, tiered key generators
│   │   ├── request-id.ts        # X-Request-ID injection
│   │   └── error-handler.ts     # gateway-level error shape, 502 on upstream failure
│   ├── routes/                  # one Fastify plugin per downstream service
│   │   ├── leads.ts             # /v1/leads/*
│   │   ├── pipeline.ts          # /v1/pipeline/* (override RBAC + channel enrichment)
│   │   ├── conversations.ts     # /v1/conversations/*
│   │   ├── campaigns.ts         # /v1/campaigns/*
│   │   ├── referrals.ts         # /v1/referrals/* (public routes first, then JWT routes)
│   │   ├── reports.ts           # /v1/reports/*
│   │   ├── imports.ts           # /v1/imports/*
│   │   └── notifications.ts     # /v1/notifications/* (SSE + standard routes)
│   ├── lib/
│   │   ├── api-key-cache.ts     # LRU (500 entries, configurable TTL) for validated ak_ keys
│   │   └── channel-resolver.ts  # calls Lead Service, extracts channel for /convert
│   └── index.ts                 # registers global plugins then route plugins
├── test/
│   ├── auth.test.ts             # JWT valid/invalid/expired; ak_ valid/invalid/cached; header stripping
│   ├── pipeline.test.ts         # override RBAC per role; channel resolution happy path + failure modes
│   ├── referrals.test.ts        # public route bypass; JWT enforcement on non-public routes
│   └── rate-limit.test.ts       # per-tier limit enforcement
├── Dockerfile
├── package.json
└── tsconfig.json
```

**Plugin registration order in `index.ts`:**
1. `request-id` — must run first so all subsequent plugins see the ID
2. `auth` — strips incoming synthetic headers, populates request context before rate-limit reads it
3. `rate-limit` — reads auth context to select key generator
4. `error-handler` — catches errors thrown by route plugins
5. Route plugins — each scoped to their `/v1/<service>` prefix

---

## 11. Environment Variables

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
| `IDENTITY_SERVICE_URL` | Identity Service base URL (VPC-internal). JWKS endpoint derived as `{IDENTITY_SERVICE_URL}/.well-known/jwks.json` — no separate env var needed. | — |
| `LEAD_SERVICE_API_KEY` | `ak_`-prefixed key for channel resolution calls to Lead Service | — |
| `INTERNAL_API_SECRET` | Shared secret for `POST /identity/api-keys/validate` | — |
| `JWKS_CACHE_TTL_MS` | JWKS cache TTL | `300000` |
| `API_KEY_CACHE_TTL_MS` | API key validation cache TTL | `60000` |
| `UPSTREAM_TIMEOUT_MS` | Upstream request timeout (non-SSE routes) | `30000` |
| `PORT` | Gateway listen port | `3000` |
| `LOG_LEVEL` | Pino log level | `info` |
| `MAX_BODY_SIZE_BYTES` | Maximum request body size for all routes except `/v1/imports/upload` | `1048576` (1MB) |
| `IMPORT_MAX_BODY_SIZE_BYTES` | Maximum request body size for `/v1/imports/upload` (Ortho2 CSV files) | `5242880` (5MB) |

All `*_URL` and `*_KEY` / `*_SECRET` values are required at startup — the service fails fast on missing config.

---

## 12. API Versioning

All proxied routes are served under the `/v1/` prefix. The gateway strips the `/v1` segment and forwards the remaining path unchanged to the upstream service — e.g., `GET /v1/leads/123/score-commentary` forwards as `GET /leads/123/score-commentary`. Path parameters, query strings, and trailing segments are preserved exactly.

When a breaking change is required, a `/v2/` route plugin is added alongside `/v1/` in the relevant service's route file. Both versions can be live simultaneously during migration. The upstream service exposes new behaviour on a separate path; the gateway maps `/v2/<route>` to the new upstream path.

No version negotiation via headers — URL path versioning only.
