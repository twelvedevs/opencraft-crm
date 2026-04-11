# Clarifying Questions: CRM API Gateway

> Original request: Implement the CRM API Gateway (`apps/crm/api-gateway`) — the single public-facing reverse proxy for the React SPA and EHR integration. Handles JWT + API key auth, tiered rate limiting, SSE proxying, pipeline RBAC enforcement, and channel resolution for `/convert`. No DB, no EventBridge, no domain logic.

## Questions

1. What is the primary role of the CRM API Gateway in the system?
   A. A BFF (Backend for Frontend) that aggregates multiple service responses
   B. A pure reverse proxy — auth enforcement, rate limiting, and header injection only; downstream errors pass through unchanged
   C. A service orchestrator that coordinates multi-step operations
   D. Other: [please specify]

   **Answer:** B. Pure reverse proxy. The gateway has no database, no EventBridge subscriptions, no domain logic, and no request aggregation. Every request is authenticated, rate-limited, header-enriched, and forwarded. Downstream error bodies and status codes are passed through as-is. The two exceptions (pipeline override RBAC check and channel resolution for `/convert`) are gateway-layer enforcement, not orchestration.

---

2. Which services does the gateway proxy, and which are explicitly out of scope?
   A. All 21 services in the monorepo
   B. The 8 CRM product services only; platform services are excluded
   C. CRM product services + Identity Service for login flows
   D. Other: [please specify]

   **Answer:** B. The gateway proxies only the 8 CRM product services under `/v1/*`: Lead, Pipeline, Conversation, Campaign, Referral, Reporting, Data Import, and Notification. Explicitly excluded: all 12 platform services (Template, Nurturing, Automation, Audience, AI, Analytics, Integration Hub, Messaging, Email, Media), plus the Identity Service (browser calls it directly for login/refresh/JWKS) and the Media Service (browser uploads via presigned S3 PUT). Platform UI components (`@platform/*`) call their own service APIs directly from the browser.

---

3. How many authentication paths exist, and how are they detected?
   A. One path — JWT only
   B. Two paths — JWT and API key
   C. Three paths — public (no auth), JWT, and API key; detected in that order
   D. Other: [please specify]

   **Answer:** C. Three paths, detected in order:
   - **Public:** exactly four routes have no auth check (`GET /health`, `GET /v1/referrals/r/:code`, `GET /v1/referrals/links/:code`, `GET /v1/referrals/portal/:token`)
   - **JWT:** `Authorization: Bearer <token>` where the value does NOT start with `ak_`; verified via RS256 against Identity Service JWKS
   - **API key:** `Authorization: Bearer ak_<hex>` — detected by the `ak_` prefix; validated via `POST /identity/api-keys/validate` with LRU caching

---

4. What headers must be stripped from incoming client requests before any injection?
   A. Only the `Authorization` header on API key routes
   B. `X-User-Id`, `X-User-Role`, `X-User-Locations`, and `X-Api-Key-Permissions` unconditionally on every request
   C. All `X-*` headers as a general policy
   D. Other: [please specify]

   **Answer:** B. Before injecting any `X-User-*` or `X-Api-Key-Permissions` headers, the `auth` plugin unconditionally strips any incoming `X-User-Id`, `X-User-Role`, `X-User-Locations`, and `X-Api-Key-Permissions` headers from the client request. This prevents clients from spoofing gateway-injected headers. The `auth` plugin is responsible for this stripping, and it happens before rate-limit reads the auth context.

---

5. What headers does the gateway inject into every forwarded request?
   A. Only `X-Request-ID`
   B. `X-Request-ID` always; `X-User-*` for JWT routes; `X-Api-Key-Permissions` for API key routes
   C. All headers on all routes regardless of auth type
   D. Other: [please specify]

   **Answer:** B. Always injected: `X-Request-ID` (UUID v4, freshly generated — any client-supplied value is discarded), `X-Forwarded-For` (ALB rightmost IP). JWT routes additionally get: `X-User-Id` (JWT `sub`), `X-User-Role` (JWT `role`), `X-User-Locations` (JWT `locations` as comma-separated string — **omitted entirely** when `locations[]` is empty, i.e. `marketing_staff`, `marketing_manager`, `super_admin`; downstream services interpret absence as "all locations"). API key routes get `X-Api-Key-Permissions` (comma-separated permissions) instead; `X-User-*` headers are omitted. Original `Authorization` header is forwarded unchanged on JWT routes; stripped (not forwarded) on API key routes.

---

6. How is JWT verification handled — per-request round-trip or cached?
   A. Per-request call to Identity Service `/verify` endpoint
   B. JWKS fetched at startup and cached; RS256 signature verified locally per request; re-fetch only on unknown `kid`
   C. Token is forwarded to downstream services which verify independently; gateway does not verify
   D. Other: [please specify]

   **Answer:** B. The `auth` plugin (using `@ortho/auth-middleware`) fetches JWKS at startup. RS256 verification is local — no per-request call to Identity Service under normal operation. On an unknown `kid`, the plugin re-fetches JWKS immediately (up to 3 retries, exponential back-off capped at 5s per retry). During unreachability with an unrecognized `kid`, requests return `401 { "error": "unauthorized" }`. The JWT is also forwarded unchanged in the `Authorization` header so downstream services can independently re-verify via their own `@ortho/auth-middleware`.

---

7. How does API key validation work and what caching strategy is used?
   A. Every API key request calls Identity Service synchronously — no caching
   B. SHA256 hash of the raw key used as cache key; LRU cache (500 entries, configurable TTL default 60s); Identity Service called only on cache miss
   C. Keys are validated once at gateway startup and held in memory for the process lifetime
   D. Other: [please specify]

   **Answer:** B. Validation flow:
   1. Compute `key_hash = SHA256(raw_key)`. Check in-process LRU cache (500 entries, `API_KEY_CACHE_TTL_MS` TTL, default 60s).
   2. Cache miss → `POST /identity/api-keys/validate` (VPC-only) with `X-Internal-Secret: <INTERNAL_API_SECRET>`, body `{ "key": "<raw key>" }`.
   3. Identity Service unreachable → fail closed: `503 { "error": "auth_unavailable" }`. Never fail open.
   4. Valid response → cache `{ permissions }` keyed on `key_hash`; update `last_used_at` on cache misses only.
   5. `keyHash` stored in request context for rate limiting and logging. Raw key is never logged or forwarded.

---

8. What happens when `must_change_password: true` is present in the JWT?
   A. The gateway allows all requests through and lets the Identity Service handle it
   B. Only password-change routes are blocked; all other routes proceed normally
   C. All routes proxied by the gateway are blocked with `403 { "error": "password_change_required" }` — no exceptions, because the exempt Identity Service paths are not proxied by this gateway
   D. Other: [please specify]

   **Answer:** C. The `auth` plugin enforces `must_change_password: true` universally. The three normally-exempt paths (`PUT /identity/me/password`, `GET /identity/me`, `DELETE /identity/session`) are Identity Service endpoints not proxied by this gateway. Therefore every route the gateway handles is blocked without exception when `must_change_password: true`.

---

9. What RBAC enforcement does the gateway perform directly (as opposed to delegating downstream)?
   A. All RBAC is delegated to downstream services — the gateway only authenticates
   B. Two cross-service flows only: pipeline override flag (`POST /v1/pipeline/transitions` with `override: true`) and channel resolution for `POST /v1/pipeline/convert`
   C. Full RBAC for all eight proxied services
   D. Other: [please specify]

   **Answer:** B. Exactly two gateway-layer RBAC rules:
   - **Pipeline override flag:** `POST /v1/pipeline/transitions` with `override: true` in body — gateway reads JWT `role` claim. Permitted: `call_center_manager`, `marketing_manager`, `super_admin`. Blocked: `call_center_agent`, `marketing_staff` → `403 { "error": "forbidden" }` without forwarding. `override: false` or absent `override` skips the check entirely.
   - **Channel resolution:** `POST /v1/pipeline/convert` — gateway calls `GET /leads/:lead_id` on Lead Service (VPC, `Authorization: Bearer <LEAD_SERVICE_API_KEY>`) and overwrites any client-supplied `channel` field. Not strictly RBAC but a data-integrity enforcement at gateway layer.
   All other RBAC is delegated to downstream services.

---

10. What are the rate limit tiers and what key is used for each?
    A. Single flat limit of 100 req/min for all callers
    B. IP-based limit for everyone
    C. Three tiers: public (IP, 60/min), JWT user (sub claim, 300/min), API key (keyHash, 600/min); `/health` is exempt from rate limiting entirely
    D. Other: [please specify]

    **Answer:** C. Implemented via `@fastify/rate-limit` as a global plugin. The plugin reads the auth context populated by the `auth` plugin to select the key generator:
    - **Public** (unauthenticated routes, excluding `/health`): IP address (ALB-injected rightmost value in `X-Forwarded-For`) → 60 req/min
    - **User** (JWT-authenticated): `sub` claim → 300 req/min
    - **API key** (`ak_`-authenticated): `keyHash` (SHA256 of raw key) → 600 req/min
    
    Rate limit exceeded: `429 { "error": "rate_limit_exceeded" }` with `Retry-After` header. No per-route overrides at launch.

---

11. How does channel resolution for `POST /v1/pipeline/convert` work, and what are the failure modes?
    A. The client supplies the channel and the gateway passes it through unchanged
    B. The gateway calls Lead Service to get the authoritative attribution channel, overwrites the client-supplied value, then forwards
    C. The Pipeline Engine resolves the channel internally
    D. Other: [please specify]

    **Answer:** B. Before forwarding `POST /v1/pipeline/convert`, the gateway:
    1. Calls `GET /leads/:lead_id` on Lead Service (VPC, `Bearer <LEAD_SERVICE_API_KEY>`).
    2. Always overwrites any client-supplied `channel` field with the resolved value — prevents spoofing.
    
    Failure cases:
    - Lead Service `404` → `404 { "error": "lead_not_found" }`, no forwarding
    - Lead Service unreachable or `5xx` → `502 { "error": "upstream_unavailable" }`, no forwarding
    - Lead Service `200` but `channel` is null, absent, not in valid enum, or response is malformed → `422 { "error": "channel_resolution_failed" }`, no forwarding
    
    Valid `channel` values: `google_ads | facebook | website | referral_patient | referral_doctor | call_tracking | walk_in | chat | google_business | import | unknown`

---

12. How is SSE proxying implemented for the notification stream?
    A. Gateway buffers the full response and sends it as a regular HTTP response
    B. Gateway streams the upstream response body directly to the client via `@fastify/reply-from` with no request timeout; passes `Last-Event-ID` upstream and adds buffering-suppression headers downstream
    C. Gateway polls the Notification Service and pushes updates to the client
    D. Other: [please specify]

    **Answer:** B. `GET /v1/notifications/stream` — JWT auth required. Implementation:
    - `@fastify/reply-from` in streaming mode pipes the upstream response body with no timeout on this route (connection is long-lived)
    - Client → upstream: `Last-Event-ID` header forwarded for reconnect replay
    - Upstream → client: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no` (added by gateway to suppress nginx/ALB buffering), `Connection: keep-alive` (set by gateway on client-facing response)
    - `Transfer-Encoding` is handled automatically by `@fastify/reply-from` — not manually set
    - No per-user concurrent SSE connection limit at v1

---

13. How are referral route public/JWT splits handled in the same plugin file?
    A. Two separate route plugin files — one for public routes, one for JWT-protected
    B. Scoped plugin pattern: public routes registered first with `{ config: { auth: false } }`; remaining routes get global JWT enforcement; auth plugin checks this config flag
    C. The entire referral route file is public; JWT enforcement is applied at gateway startup config
    D. Other: [please specify]

    **Answer:** B. The `referrals.ts` route plugin registers public routes first with `{ config: { auth: false } }`. The `auth` plugin checks this config flag on each request and skips JWT verification for those routes. The four public referral routes are: `GET /v1/referrals/r/:code` (click redirect, must return `302` as-is with `followRedirects: false`), `GET /v1/referrals/links/:code`, and `GET /v1/referrals/portal/:token`. All remaining `/v1/referrals/*` routes fall through to global JWT enforcement.

---

14. How does path versioning work — what does the gateway do with the `/v1` prefix?
    A. The `/v1` prefix is forwarded unchanged to upstream services
    B. The gateway strips the `/v1` segment before forwarding; upstream services see paths without the version prefix (e.g. `GET /v1/leads/123` → `GET /leads/123`)
    C. Upstream services are deployed under `/v1/` URLs natively
    D. Other: [please specify]

    **Answer:** B. The gateway strips the `/v1` segment and forwards the remaining path unchanged. `GET /v1/leads/123/score-commentary` → `GET /leads/123/score-commentary`. Path parameters, query strings, and trailing segments are preserved. For breaking changes, a `/v2/` route plugin is added alongside `/v1/`; both can be live simultaneously. Version negotiation is URL path only — no header-based versioning.

---

15. What plugin registration order must be followed in `index.ts`, and why?
    A. Any order — Fastify handles plugin dependencies automatically
    B. `request-id` → `auth` → `rate-limit` → `error-handler` → route plugins; order is critical for correct context propagation
    C. Route plugins first, then global plugins
    D. Other: [please specify]

    **Answer:** B. Strict order:
    1. `request-id` — must run first so all subsequent plugins (including auth and logging) see the `X-Request-ID`
    2. `auth` — strips incoming synthetic headers, populates request context (JWT payload or API key permissions) before `rate-limit` reads it
    3. `rate-limit` — reads auth context to select key generator (must come after `auth`)
    4. `error-handler` — catches errors thrown by route plugins
    5. Route plugins — each scoped to their `/v1/<service>` prefix

---

16. What body size limits apply, and how are they scoped?
    A. Single 10MB limit for all routes
    B. 1MB for all routes except `/v1/imports/upload` which gets 5MB; controlled by two separate env vars
    C. No body size limits — downstream services handle their own limits
    D. Other: [please specify]

    **Answer:** B. Two limits:
    - `MAX_BODY_SIZE_BYTES` (default `1048576` = 1MB): all routes except `/v1/imports/upload`
    - `IMPORT_MAX_BODY_SIZE_BYTES` (default `5242880` = 5MB): `/v1/imports/upload` only (Ortho2 CSV files)
    Both are configured via env vars.

---

17. What is the upstream timeout policy, and what happens when it is exceeded?
    A. No timeout — connections are held open indefinitely
    B. 30s timeout on all routes including SSE; `502` on timeout
    C. `UPSTREAM_TIMEOUT_MS` (default 30000ms) on all proxied requests except the SSE stream (which has no timeout); timeout → `502 { "error": "upstream_unavailable" }`
    D. Other: [please specify]

    **Answer:** C. All proxied requests use `UPSTREAM_TIMEOUT_MS` (default 30000ms). The SSE stream (`GET /v1/notifications/stream`) is explicitly excluded — it has no timeout because the connection is long-lived. On timeout for non-SSE routes, the gateway returns `502 { "error": "upstream_unavailable" }`.

---

18. What gateway-generated errors exist, and what is the response shape convention?
    A. Gateway returns downstream error codes and bodies verbatim; no gateway-generated errors
    B. Gateway generates its own errors only for auth/rate-limit/RBAC/channel-resolution/upstream failures; all use `{ "error": "<message>" }` shape; downstream errors pass through as-is
    C. Gateway wraps all errors in a unified envelope with nested downstream error
    D. Other: [please specify]

    **Answer:** B. Gateway-generated errors (own responses, not pass-through):
    | Condition | Status | Body |
    |---|---|---|
    | Missing/invalid/expired JWT | 401 | `{ "error": "unauthorized" }` |
    | Invalid/revoked API key | 401 | `{ "error": "unauthorized" }` |
    | Identity Service unreachable (API key validation) | 503 | `{ "error": "auth_unavailable" }` |
    | `must_change_password: true` | 403 | `{ "error": "password_change_required" }` |
    | `override: true` RBAC violation | 403 | `{ "error": "forbidden" }` |
    | Rate limit exceeded | 429 | `{ "error": "rate_limit_exceeded" }` + `Retry-After` |
    | Lead not found (channel resolution) | 404 | `{ "error": "lead_not_found" }` |
    | Channel null/invalid/missing | 422 | `{ "error": "channel_resolution_failed" }` |
    | Upstream unreachable/timeout | 502 | `{ "error": "upstream_unavailable" }` |
    
    All other downstream errors pass through unchanged. No `token_expired` sub-code — the browser treats all `401`s on authenticated routes as a refresh trigger.

---

19. What does the health check endpoint look like?
    A. `GET /v1/health` with JWT auth required
    B. `GET /health` (no `/v1/` prefix), no auth, no rate limiting, returns `200 { "status": "ok" }` — used by ECS Fargate target group
    C. `GET /healthz` returning 204 No Content
    D. Other: [please specify]

    **Answer:** B. `GET /health` — no version prefix, no auth check, not rate-limited. Returns `200 { "status": "ok" }`. Used by ECS Fargate target group health checks.

---

20. What logging fields are captured per request?
    A. Method, path, and status code only
    B. `request_id`, `method`, `path`, `status_code`, `duration_ms`, `user_id` (JWT), `key_hash` (API key), `upstream_service`; no body logging
    C. Full request and response bodies with PII redaction
    D. Other: [please specify]

    **Answer:** B. Every request is logged via `@ortho/logger` (Pino, Datadog-compatible) with: `request_id`, `method`, `path`, `status_code`, `duration_ms`, `user_id` (JWT routes only), `key_hash` (API key routes — SHA256 of raw key, never the raw key itself), `upstream_service`. **No request or response body logging.**

---

21. What environment variables are required at startup, and what happens if any are missing?
    A. All env vars have sensible defaults; the service starts regardless
    B. All `*_URL`, `*_KEY`, and `*_SECRET` env vars are required; the service fails fast on any missing value; several numeric vars have defaults
    C. Only `PORT` and `LOG_LEVEL` are required
    D. Other: [please specify]

    **Answer:** B. Required (no default — service fails fast if absent): `LEAD_SERVICE_URL`, `PIPELINE_SERVICE_URL`, `CONVERSATION_SERVICE_URL`, `CAMPAIGN_SERVICE_URL`, `REFERRAL_SERVICE_URL`, `REPORTING_SERVICE_URL`, `IMPORT_SERVICE_URL`, `NOTIFICATION_SERVICE_URL`, `IDENTITY_SERVICE_URL`, `LEAD_SERVICE_API_KEY`, `INTERNAL_API_SECRET`. Optional with defaults: `JWKS_CACHE_TTL_MS` (300000), `API_KEY_CACHE_TTL_MS` (60000), `UPSTREAM_TIMEOUT_MS` (30000), `PORT` (3000), `LOG_LEVEL` (info), `MAX_BODY_SIZE_BYTES` (1048576), `IMPORT_MAX_BODY_SIZE_BYTES` (5242880). JWKS URL is derived as `{IDENTITY_SERVICE_URL}/.well-known/jwks.json` — no separate env var.

---

22. What internal code structure and file layout is expected?
    A. Single `index.ts` file for simplicity given the gateway's pure-proxy nature
    B. Structured per the design: `src/plugins/` (auth, rate-limit, request-id, error-handler), `src/routes/` (one plugin per downstream service), `src/lib/` (api-key-cache, channel-resolver), `src/index.ts`
    C. Mirror the structure of other CRM services including `repositories/` and `services/` directories
    D. Other: [please specify]

    **Answer:** B. Exact structure from the design spec:
    ```
    apps/crm/api-gateway/
    ├── src/
    │   ├── plugins/
    │   │   ├── auth.ts              # JWT + API key detection, validation, context; strips X-User-* headers
    │   │   ├── rate-limit.ts        # @fastify/rate-limit, tiered key generators
    │   │   ├── request-id.ts        # X-Request-ID injection
    │   │   └── error-handler.ts     # gateway-level error shape, 502 on upstream failure
    │   ├── routes/                  # one Fastify plugin per downstream service
    │   │   ├── leads.ts, pipeline.ts, conversations.ts, campaigns.ts
    │   │   ├── referrals.ts         # public routes first, then JWT routes
    │   │   ├── reports.ts, imports.ts
    │   │   └── notifications.ts     # SSE + standard routes
    │   ├── lib/
    │   │   ├── api-key-cache.ts     # LRU (500 entries, configurable TTL)
    │   │   └── channel-resolver.ts  # calls Lead Service, extracts channel for /convert
    │   └── index.ts                 # global plugins then route plugins
    ├── test/
    │   ├── auth.test.ts, pipeline.test.ts, referrals.test.ts, rate-limit.test.ts
    ├── Dockerfile, package.json, tsconfig.json
    ```
    No `migrations/`, `repositories/`, `services/`, or `queue/` directories — the gateway has no DB and no domain logic.

---

23. What test coverage is required?
    A. No tests required for a proxy service
    B. Four integration test files covering: auth flows (JWT/API key/header stripping), pipeline RBAC + channel resolution, referral public/JWT split, rate limit tier enforcement
    C. Unit tests only for the auth and cache modules
    D. Other: [please specify]

    **Answer:** B. Four test files specified in the design:
    - `auth.test.ts` — JWT valid/invalid/expired; `ak_` valid/invalid/cached; header stripping (verify X-User-* cannot be spoofed); `must_change_password` enforcement
    - `pipeline.test.ts` — override RBAC per role (all five roles); channel resolution happy path; all channel resolution failure modes (404, 5xx, null channel, malformed response)
    - `referrals.test.ts` — public route bypass (no auth required); JWT enforcement on non-public routes; `followRedirects: false` on the click redirect route
    - `rate-limit.test.ts` — per-tier limit enforcement (public IP, user sub, API key hash); `/health` exemption

---

24. How should `triggered_by` be handled for API key callers on pipeline routes?
    A. Gateway injects `triggered_by` based on the API key's identity
    B. Internal services (Automation Engine, Data Import Service) are responsible for including `triggered_by` in the request body; gateway forwards it as-is without modification
    C. `triggered_by` is only relevant for JWT callers; API key callers do not need it
    D. Other: [please specify]

    **Answer:** B. For API key callers on pipeline routes, internal services are responsible for including `triggered_by` in the request body. The gateway forwards the body field as-is — no injection, no validation. This is consistent with the service-to-service `ak_` key pattern used throughout the platform (Automation Engine, Data Import Service).

---

25. How does the gateway handle the referral click redirect to preserve click-tracking intent?
    A. The gateway follows the `302` redirect from the Referral Service and returns the final destination to the browser
    B. `@fastify/reply-from` configured with `followRedirects: false` on the click redirect route so the `302` is returned to the browser as-is
    C. The gateway issues its own `302` to the destination URL after logging the click
    D. Other: [please specify]

    **Answer:** B. `GET /v1/referrals/r/:code` is a public route where the Referral Service returns a `302`. The gateway must be configured with `followRedirects: false` on this specific route so the `302` is returned to the browser unchanged rather than silently followed. This preserves the click-tracking intent — the browser's request is what the Referral Service logs as a tracked click event.

---

## Additional Context

The CRM API Gateway is the last CRM product service to be implemented. All downstream services it proxies are already built. Key implementation notes:

- Technology: Fastify 5, TypeScript 5 (ESM), Node.js 24
- Packages to use: `@fastify/reply-from` for proxying, `@fastify/rate-limit` for rate limiting, `@ortho/auth-middleware` for JWT verification, `@ortho/logger` for structured logging
- No BullMQ, no Knex/Drizzle, no `@ortho/db`, no `@ortho/event-bus` — this service is intentionally thin
- The gateway is the only CRM product service with no `migrations/` directory
- All upstream service URLs are static env vars — no service discovery
- The `lib/api-key-cache.ts` module implements an LRU cache; consider using the `lru-cache` npm package
- `channel-resolver.ts` must handle all malformed/unparseable Lead Service responses identically to null/absent `channel` (return `422`)
- The gateway itself is a service-to-service caller when it calls Lead Service for channel resolution — it uses `LEAD_SERVICE_API_KEY` directly as a Bearer token to the Lead Service's VPC endpoint
