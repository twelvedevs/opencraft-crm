# Identity Service — Updated Design Spec

**Date:** 2026-04-02
**Status:** Approved
**Supersedes:** `docs/superpowers/specs/2026-03-25-identity-service-design.md`
**Scope:** Platform-layer Identity Service — authentication, enriched JWT issuance, RBAC, user management, API key management, **and `packages/@ortho/auth-middleware`**

---

## Change Summary (vs 2026-03-25 spec)

| Topic | Original | Updated |
|---|---|---|
| JWT library | Unspecified | `fast-jwt` (RS256 sign + verify) |
| Auth providers in scope | Pluggable interface, one concrete impl implied | Both **Supabase Auth** and **Auth0** fully implemented |
| `@ortho/auth-middleware` | Referenced as consumer package | **Delivered as part of this PRD** |
| Cursor pagination | "cursor-paginated" — format unspecified | Opaque base64 `{ created_at, id }` keyset |
| Local dev key setup | Unspecified | `scripts/generate-dev-keys.ts` + `.env` support |
| Re-activation response | "422 out of scope" | `422 { "error": "reactivation_not_supported" }` |
| `/validate` protection | VPC + `X-Internal-Secret` | + Fastify `preHandler` enforces secret in-process |
| `PUT /me/password` schema | Conditional `current_password` | Always optional in TypeBox; service layer decides |
| Redis instance | Unspecified | Shared monorepo `REDIS_URL` |
| Password policy | Delegated to auth provider | Identity Service enforces configurable policy first |
| Seed script idempotency | Unspecified | Idempotent for DB row; surfaces provider duplicate error |
| Request-scoped logging | Unspecified | Child loggers binding `{ requestId, userId }` |
| Rate limiting | ALB only | ALB only — no `@fastify/rate-limit` in service |
| CORS | Unspecified | `@fastify/cors` with `CORS_ORIGIN` env var |
| Testing | Unspecified | Unit tests + HTTP-layer integration tests (Fastify inject) |

---

## 1. Overview

The Identity Service is a **platform-layer service** (`apps/platform/identity`) that owns the canonical user record, issues enriched JWTs consumed by every other service, and manages staff accounts and API keys. It is shared across all products in the deployment.

This PRD also delivers **`packages/@ortho/auth-middleware`** — the Fastify plugin consumed by every other service for JWT verification and RBAC enforcement. Both deliverables are built together because `auth-middleware` is the primary consumer interface of Identity Service's JWKS endpoint and claims model.

**Core responsibilities:**
- Exchange auth provider tokens for enriched JWTs carrying role and location claims
- Issue and rotate refresh tokens
- Serve a JWKS endpoint for distributed JWT verification across all services
- Own the user record: create, update, deactivate staff accounts
- Manage location assignments per user
- Generate and validate long-lived API keys for EHR integration
- Enforce configurable password complexity policy before delegating to the auth provider

**Out of scope:**
- Raw credential storage (passwords, OAuth tokens) — delegated to auth provider
- Session UI — frontend handles login form and token storage directly
- Fine-grained permission customization per user — permissions are role-based only
- User re-activation (`status: active` on inactive user returns `422` — deferred post-launch)

---

## 2. Architecture

```
                     ┌──────────────────────────────────────────────┐
                     │           Auth Provider                       │
                     │  (Supabase Auth OR Auth0 — pluggable)        │
                     │  Owns: passwords, MFA, OAuth tokens          │
                     └────────────────────┬─────────────────────────┘
                                          │ provider token (short-lived)
                                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       Identity Service                                │
│              apps/platform/identity                                   │
│                                                                       │
│  POST /identity/session                                               │
│       │                                                               │
│  1. Validate provider token via AuthProvider interface                │
│  2. Load user row + location assignments from platform_identity DB    │
│  3. Issue signed enriched JWT (RS256/fast-jwt, 15min TTL)            │
│  4. Issue refresh token (SHA256-hashed, stored, 30-day TTL)          │
│       │                                                               │
│       ▼                                                               │
│  Enriched JWT ──────────────────────────────────────────────────►    │
│                                     All services verify via JWKS     │
│  GET /identity/.well-known/jwks.json ◄── @ortho/auth-middleware      │
│                                          (cached, re-fetches on      │
│                                           unknown kid)               │
│                                                                       │
│  Rate limiting: ALB only (10 req/min per IP on session + refresh)    │
│  CORS: @fastify/cors, CORS_ORIGIN env var                            │
└──────────────────────────────────────────────────────────────────────┘
              │
     platform_identity schema (PostgreSQL)
```

**Login flow:**
1. Frontend submits credentials directly to the auth provider — Identity Service never sees raw passwords
2. Auth provider returns a short-lived provider token
3. Frontend calls `POST /identity/session` with the provider token
4. Identity Service validates the token via `AuthProvider`, loads role + location assignments, issues enriched JWT (15-min TTL) + refresh token (30-day TTL)
5. All subsequent API calls carry the enriched JWT — no further Identity Service round-trips per request

**JWT verification across services:** Every service verifies JWTs locally using the JWKS endpoint. `@ortho/auth-middleware` fetches and caches JWKS at startup. On receiving a JWT with a `kid` not in the local cache, the middleware immediately re-fetches the endpoint once (with exponential back-off on failure). No per-request call to Identity Service under normal operation.

---

## 3. JWT Library

**Library:** `fast-jwt` — consistent with integration-hub's use of `fast-jwt` for JWT verification.

Used for:
- **Signing:** `createSigner({ algorithm: 'RS256', key: privateKey, kid })` in `token.service.ts`
- **Verifying (auth-middleware):** `createVerifier({ algorithms: ['RS256'], key: jwksKeyProvider })` — verifier is rebuilt when JWKS cache is refreshed

The `fast-jwt` `createSigner` and `createVerifier` factories produce cached closures; they are instantiated once at service startup (or on JWKS refresh in auth-middleware) and reused per request.

---

## 4. Auth Provider Abstraction

```typescript
interface AuthProvider {
  // Validates a provider-issued token; returns provider user ID + email on success
  verifyToken(token: string): Promise<{ providerUserId: string; email: string }>

  // Creates a credential record in the auth provider
  createUser(email: string, password: string): Promise<{ providerUserId: string }>

  // Updates the credential password (skips old-password verification — service layer handles that)
  setPassword(providerUserId: string, password: string): Promise<void>

  // Disables login for this credential (does not delete)
  deactivateUser(providerUserId: string): Promise<void>
}
```

**Provider selection:** `AUTH_PROVIDER` env var (`supabase` | `auth0`). Both implementations are bundled and instantiated at startup. No code change required to switch.

**Both providers are fully implemented** in this PRD — no stubs.

### Supabase Auth implementation

| Method | Implementation |
|---|---|
| `verifyToken` | `supabase.auth.getUser(token)` |
| `createUser` | `supabase.auth.admin.createUser({ email, password, email_confirm: true })` |
| `setPassword` | `supabase.auth.admin.updateUserById(id, { password })` |
| `deactivateUser` | `supabase.auth.admin.updateUserById(id, { ban_duration: 'none' })` → actually uses `deleteUser` or bans; preferred: `updateUserById` with `ban_duration: '87600h'` (10 years) |

### Auth0 implementation

| Method | Implementation |
|---|---|
| `verifyToken` | Validate Auth0 access token against Auth0's JWKS (`/.well-known/jwks.json`) |
| `createUser` | Auth0 Management API `POST /api/v2/users` |
| `setPassword` | Auth0 Management API `PATCH /api/v2/users/:id` with `{ password }` |
| `deactivateUser` | Auth0 Management API `PATCH /api/v2/users/:id` with `{ blocked: true }` |

Auth0 Management API requires a machine-to-machine access token (client credentials flow). This token is cached and refreshed before expiry — managed inside `Auth0Provider`.

---

## 5. JWT Claims

**Payload shape:**

```json
{
  "sub": "user-uuid",
  "role": "call_center_agent",
  "locations": ["loc-uuid-1", "loc-uuid-2"],
  "must_change_password": false,
  "iat": 1234567890,
  "exp": 1234568790
}
```

**Role enum:** `call_center_agent` | `call_center_manager` | `marketing_staff` | `marketing_manager` | `super_admin`

**`locations` array semantics:**

| Role | `locations` value | Interpretation |
|---|---|---|
| `call_center_agent` | `["loc-uuid"]` | Exactly one home location |
| `call_center_manager` | `["loc-a", "loc-b", ...]` | One or more assigned locations |
| `marketing_staff` | `[]` | Empty — interpreted as "all locations" |
| `marketing_manager` | `[]` | Empty — interpreted as "all locations" |
| `super_admin` | `[]` | Empty — bypasses all permission checks |

**Permission resolution:** Purely role-based. `@ortho/auth-middleware` holds a static `ROLE_PERMISSIONS` constant. Permissions resolved at request time from the `role` claim — not stored in the JWT.

**`must_change_password`:** Set `true` on account creation. `@ortho/auth-middleware` rejects any JWT with `must_change_password: true` with `403 { "error": "password_change_required" }` on all endpoints **except** `PUT /identity/me/password`, `GET /identity/me`, and `DELETE /identity/session`.

**Signing:** RS256, RSA-2048. Private key from `IDENTITY_PRIVATE_KEY` env var. Each key pair carries a `kid` in the JWT header and JWKS response.

**Key rotation procedure:**
1. Generate new key pair; add to `IDENTITY_JWKS_KEYS` alongside existing key
2. Deploy — JWKS now serves both keys
3. New JWTs signed with new `kid`; old JWTs continue to verify for up to 15-minute TTL
4. After 15 minutes, remove old key from `IDENTITY_JWKS_KEYS` and redeploy

---

## 6. Password Policy

Identity Service enforces a configurable password complexity policy **before** calling `AuthProvider.setPassword` or `AuthProvider.createUser`. The auth provider's own rules remain a backstop, but the service-level policy is the enforced contract.

**Policy env vars:**

| Variable | Default | Description |
|---|---|---|
| `PASSWORD_MIN_LENGTH` | `12` | Minimum character count |
| `PASSWORD_REQUIRE_UPPERCASE` | `true` | At least one A–Z character |
| `PASSWORD_REQUIRE_LOWERCASE` | `true` | At least one a–z character |
| `PASSWORD_REQUIRE_NUMBER` | `true` | At least one 0–9 digit |
| `PASSWORD_REQUIRE_SPECIAL` | `true` | At least one special character (`!@#$%^&*` etc.) |

**Validation:** A `password-policy.ts` module exports a single `validatePassword(password: string): { valid: boolean; errors: string[] }` function. Called in `user.service.ts` before any auth provider call. On failure returns `400 { "error": "password_policy_violation", "details": [...] }`.

**Applied on:** `POST /identity/users` (admin create), `PUT /identity/me/password`, `PUT /identity/users/:id/password` (admin reset).

---

## 7. Database Schema (`platform_identity`)

### `users`

```sql
id                   uuid         PRIMARY KEY DEFAULT gen_random_uuid()
provider_user_id     varchar      UNIQUE NOT NULL  -- auth provider internal ID
email                varchar      UNIQUE NOT NULL
name                 varchar      NOT NULL
role                 varchar      NOT NULL
                     CHECK (role IN ('call_center_agent','call_center_manager',
                                     'marketing_staff','marketing_manager','super_admin'))
status               varchar      NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','inactive'))
force_password_reset boolean      NOT NULL DEFAULT true
created_by           uuid         REFERENCES users(id) NULLABLE
created_at           timestamptz  NOT NULL DEFAULT now()
updated_at           timestamptz  NOT NULL DEFAULT now()
```

`CHECK` constraint used (not Postgres `ENUM`) — simpler to extend via `ALTER TABLE` when EHR roles are added.

### `user_locations`

```sql
user_id     uuid  REFERENCES users(id) ON DELETE CASCADE
location_id uuid  NOT NULL
PRIMARY KEY (user_id, location_id)
```

Not populated for `marketing_staff`, `marketing_manager`, `super_admin`.

### `refresh_tokens`

```sql
id           uuid         PRIMARY KEY DEFAULT gen_random_uuid()
user_id      uuid         REFERENCES users(id) ON DELETE CASCADE
token_hash   varchar      UNIQUE NOT NULL  -- SHA256 of raw token
expires_at   timestamptz  NOT NULL
revoked_at   timestamptz  NULLABLE
created_at   timestamptz  NOT NULL DEFAULT now()
```

**Rotation on use:** each `POST /identity/refresh` revokes presented token + issues a new one.

**Replay detection:** `revoked_at IS NOT NULL` on a presented token → bulk-revoke all tokens for `user_id` → `401 { "error": "session_invalidated" }`.

**Cleanup:** BullMQ daily job prunes `expires_at < now() OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')`.

### `api_keys`

```sql
id           uuid         PRIMARY KEY DEFAULT gen_random_uuid()
name         varchar      NOT NULL
key_hash     varchar      UNIQUE NOT NULL  -- SHA256 of raw key (prefix: ak_)
permissions  varchar[]    NOT NULL
created_by   uuid         REFERENCES users(id)
created_at   timestamptz  NOT NULL DEFAULT now()
last_used_at timestamptz  NULLABLE
revoked_at   timestamptz  NULLABLE
```

Raw key returned once on creation, never stored. Format: `ak_<32 random bytes hex>`. No `expires_at` — revoke-only.

---

## 8. API

### Auth Flow

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/identity/session` | None | Exchange provider token → enriched JWT + refresh token. Rate-limited at ALB (10 req/min/IP). |
| `POST` | `/identity/refresh` | None | Exchange refresh token → new JWT + new refresh token. Body: `{ "refresh_token": "<raw>" }`. Rate-limited at ALB. |
| `DELETE` | `/identity/session` | JWT | Logout. Body: `{ "refresh_token": "<raw>" }`. Revokes only the presented token. |
| `GET` | `/identity/.well-known/jwks.json` | None | Public JWKS for JWT verification. |
| `GET` | `/identity/me` | JWT | Own profile: `{ id, email, name, role, locations, force_password_reset, status }`. |
| `PUT` | `/identity/me/password` | JWT | Change password. TypeBox: `current_password` always optional. Service layer reads `must_change_password` from JWT: if `true`, `current_password` is ignored and not required; if `false`, `current_password` is required and verified via `AuthProvider.verifyToken` equivalent before updating. Returns `200 {}`. Clears `force_password_reset`. |

### User Management — `require-role(['marketing_manager', 'super_admin'])`

| Method | Path | Description |
|---|---|---|
| `POST` | `/identity/users` | Create user. `force_password_reset: true`. Password validated against policy before calling provider. |
| `GET` | `/identity/users` | List users. Filterable by `role`, `status`. Cursor-paginated: opaque base64 `{ created_at, id }` keyset, default page size 50. |
| `GET` | `/identity/users/:id` | Get user. |
| `PUT` | `/identity/users/:id` | Update name, role, location assignments, or status. `status: inactive` → bulk-revoke refresh tokens + `AuthProvider.deactivateUser()`. `status: active` on an already-inactive user → `422 { "error": "reactivation_not_supported" }`. Outstanding JWTs valid up to 15-min TTL. |
| `PUT` | `/identity/users/:id/password` | Admin password reset. Password validated against policy. Sets `force_password_reset = true`. No notification sent. |

### API Key Management — `require-role(['marketing_manager', 'super_admin'])`

| Method | Path | Description |
|---|---|---|
| `POST` | `/identity/api-keys` | Generate key; returns raw key once. |
| `GET` | `/identity/api-keys` | List keys (name, permissions, last_used_at, status). |
| `DELETE` | `/identity/api-keys/:id` | Revoke key. |
| `POST` | `/identity/api-keys/validate` | **VPC-only.** Protected by Fastify `preHandler` that checks `req.headers['x-internal-secret'] === INTERNAL_API_SECRET` env var. Returns `{ "permissions": [...] }` or `401`. CRM API Gateway caches valid responses for 60s. Updates `last_used_at` on cache miss only. |

### Cursor Pagination (`GET /identity/users`)

Cursor is an opaque base64-encoded JSON string `{ "created_at": "<iso>", "id": "<uuid>" }`. Query params: `?limit=50&cursor=<base64>`. Response includes `next_cursor` (null if last page). Consistent with other services using this pattern.

### Response Shapes

**`POST /identity/session` → 200**
```json
{
  "access_token": "<jwt>",
  "refresh_token": "<raw-token>",
  "expires_in": 900
}
```

**`POST /identity/users` → 201**
```json
{
  "id": "uuid",
  "email": "staff@example.com",
  "name": "Jane Smith",
  "role": "call_center_agent",
  "locations": ["loc-uuid"],
  "status": "active",
  "force_password_reset": true
}
```

**`POST /identity/api-keys` → 201**
```json
{
  "id": "uuid",
  "name": "EHR Integration",
  "key": "ak_a1b2c3...",
  "permissions": ["leads:read", "pipeline:write"]
}
```

**`400` password policy violation**
```json
{
  "error": "password_policy_violation",
  "details": ["minimum 12 characters required", "at least one special character required"]
}
```

**Error shape** (all other errors):
```json
{ "error": "<message>" }
```

---

## 9. CORS

`@fastify/cors` is registered on the Fastify instance. The frontend calls `/identity/session`, `/identity/refresh`, and `/identity/me` directly from the browser (not proxied via CRM API Gateway).

| Env var | Example | Description |
|---|---|---|
| `CORS_ORIGIN` | `https://app.orthocrm.com` | Allowed origin(s). Comma-separated for multiple. In dev, set to `http://localhost:5173` or `*`. |

JWKS endpoint (`/.well-known/jwks.json`) is public and must also be browser-accessible for any future frontend-side JWT inspection.

---

## 10. Rate Limiting

Rate limiting is handled **exclusively at the ALB** (10 req/min per IP on `POST /identity/session` and `POST /identity/refresh`). No `@fastify/rate-limit` plugin is added to the service. Local dev operates without rate limits.

---

## 11. Logging

Uses `createLogger('identity')` from `@ortho/logger` (Pino, Datadog-compatible). Route handlers create child loggers with request-scoped context:

```typescript
const reqLog = log.child({ requestId: req.id, userId: req.user?.sub });
```

`userId` (`req.user?.sub`) is bound to child loggers on authenticated routes to correlate log lines with staff accounts. This is staff PII (not patient PHI) and is acceptable per the no-PHI-at-launch constraint.

**Do not** log raw passwords, raw refresh tokens, or raw API keys at any level. Log `token_hash` or `key_id` only.

---

## 12. Local Development — Key Setup

A `scripts/generate-dev-keys.ts` script generates RSA-2048 key pairs for local development and writes them to `.env`:

```bash
npx tsx scripts/generate-dev-keys.ts
```

Output to `.env` (created if not present, merged if exists):
```
IDENTITY_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
IDENTITY_JWKS_KEYS='[{"kid":"dev-1","kty":"RSA","n":"...","e":"AQAB"}]'
```

For CI and deployed environments, values come from env vars directly (AWS Secrets Manager via ECS task definition injection). The script is a dev convenience only — never commit generated `.env` files.

---

## 13. Internal Service Structure

```
apps/platform/identity/
├── src/
│   ├── routes/
│   │   ├── session.ts           # POST /session, POST /refresh, DELETE /session
│   │   ├── jwks.ts              # GET /.well-known/jwks.json
│   │   ├── me.ts                # GET /me, PUT /me/password
│   │   ├── users.ts             # user CRUD
│   │   └── api-keys.ts          # key management + /validate
│   ├── services/
│   │   ├── token.service.ts     # JWT sign (fast-jwt), JWKS serving, refresh token rotation
│   │   ├── user.service.ts      # user CRUD, location assignment, password policy enforcement
│   │   └── api-key.service.ts   # key generation, hash, validation
│   ├── repositories/
│   │   ├── user.repo.ts
│   │   ├── refresh-token.repo.ts
│   │   └── api-key.repo.ts
│   ├── providers/
│   │   ├── auth-provider.interface.ts
│   │   ├── supabase.provider.ts          # full implementation
│   │   └── auth0.provider.ts             # full implementation
│   ├── jobs/
│   │   └── cleanup.job.ts       # daily BullMQ job: prune expired + old revoked refresh tokens
│   ├── lib/
│   │   └── password-policy.ts   # validatePassword(password): { valid, errors[] }
│   └── index.ts
├── scripts/
│   └── generate-dev-keys.ts     # dev convenience: generates RSA keys → .env
├── migrations/
├── test/
│   ├── unit/
│   │   ├── token.service.test.ts
│   │   ├── user.service.test.ts
│   │   ├── api-key.service.test.ts
│   │   ├── password-policy.test.ts
│   │   └── providers/           # mock-based unit tests for both providers
│   └── integration/
│       ├── session.test.ts      # full HTTP layer via Fastify inject
│       ├── users.test.ts
│       ├── api-keys.test.ts
│       └── me.test.ts
├── Dockerfile
├── package.json
└── tsconfig.json
```

---

## 14. `packages/@ortho/auth-middleware`

Fastify plugin consumed by all services. Delivered as part of this PRD.

```
packages/@ortho/auth-middleware/
├── src/
│   ├── plugin.ts              # verifies JWT via JWKS (fast-jwt createVerifier);
│   │                          # caches JWKS, selects key by kid;
│   │                          # re-fetches on unknown kid (once, with back-off);
│   │                          # attaches user context to request;
│   │                          # rejects must_change_password: true with 403
│   │                          # except on PUT /identity/me/password,
│   │                          # GET /identity/me, DELETE /identity/session
│   ├── permissions.ts         # static ROLE_PERMISSIONS map (from PRD permission table)
│   ├── require-permission.ts  # preHandler: checks ROLE_PERMISSIONS[role].includes(perm) → 403
│   ├── require-role.ts        # preHandler: enforce minimum role level
│   └── require-location.ts    # preHandler: enforce location claim or marketing/super_admin role
├── package.json
└── tsconfig.json
```

**JWKS caching strategy:** Cache is a `Map<kid, KeyObject>`. Populated at plugin registration. On unknown `kid`: re-fetch once (max 1 re-fetch per 60s to prevent thundering herd during key rotation). Exponential back-off on fetch failure: 1s → 2s → 4s (max 3 attempts), then `503`.

---

## 15. BullMQ / Redis

The BullMQ cleanup job connects to the **shared monorepo Redis instance** via `REDIS_URL` env var — consistent with all other services. No separate Redis connection for Identity Service.

```typescript
// jobs/cleanup.job.ts
const queue = new Queue('identity-cleanup', { connection: new IORedis(process.env.REDIS_URL) });
```

Job schedule: daily at 03:00 UTC. Prunes:
- `refresh_tokens` where `expires_at < now()`
- `refresh_tokens` where `revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days'`

---

## 16. Seed Script

```
apps/platform/identity/scripts/seed-super-admin.ts
```

**Behaviour:**
- Reads `SEED_EMAIL` and `SEED_PASSWORD` from env vars
- Validates `SEED_PASSWORD` against password policy before proceeding
- **Idempotent for the DB row:** Uses `INSERT ... ON CONFLICT (email) DO NOTHING` — safe to re-run
- **Auth provider:** Calls `AuthProvider.createUser()` — if the provider returns a duplicate-email error, surfaces it clearly and exits non-zero (operator must resolve in the provider console)
- Inserts `users` row with `force_password_reset = true`, `created_by = NULL`
- Logs the created `user_id` to stdout

**Usage:**
```bash
SEED_EMAIL=admin@example.com SEED_PASSWORD=Temppass1! npx tsx scripts/seed-super-admin.ts
```

---

## 17. No Events Published

Identity Service publishes no EventBridge events. User creation and role changes are synchronous management operations. No other service reacts to them in real time.

---

## 18. Key Constraints

- **Multi-location native:** Identity Service does not validate location UUIDs — stores whatever UUIDs the caller passes. Invalid location UUIDs result in incorrect `locations[]` claims; this is a caller error.
- **API keys are not location-scoped.** Permission-string scoped only.
- **EHR SSO:** When EHR launches, it joins the same deployment. EHR staff roles are added by extending the `CHECK` constraint via migration and bumping `@ortho/auth-middleware` with new role → permissions mapping.
- **No PHI at launch:** `platform_identity` stores staff PII (name, email) only.
- **Re-activation:** `PUT /identity/users/:id` with `status: active` on an inactive user returns `422 { "error": "reactivation_not_supported" }`. The `status` field is accepted in the TypeBox schema to allow future extension; the service layer enforces the restriction.
- **15-minute JWT bleed on deactivation:** Outstanding JWTs remain valid for up to 15 minutes after a user is deactivated. Accepted consequence of the stateless JWT model.

---

## 19. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string for `platform_identity` schema |
| `REDIS_URL` | Yes | Shared Redis for BullMQ cleanup job |
| `AUTH_PROVIDER` | Yes | `supabase` or `auth0` |
| `IDENTITY_PRIVATE_KEY` | Yes | PEM-encoded RSA-2048 private key for JWT signing |
| `IDENTITY_JWKS_KEYS` | Yes | JSON array of public JWK objects (supports multiple for rotation) |
| `INTERNAL_API_SECRET` | Yes | Pre-shared secret for `POST /identity/api-keys/validate` (VPC-only) |
| `CORS_ORIGIN` | Yes | Allowed browser origin(s), comma-separated |
| `LOG_LEVEL` | No | Pino log level (default: `info`) |
| `PORT` | No | HTTP port (default: `3000`) |
| `PASSWORD_MIN_LENGTH` | No | Minimum password length (default: `12`) |
| `PASSWORD_REQUIRE_UPPERCASE` | No | Require uppercase (default: `true`) |
| `PASSWORD_REQUIRE_LOWERCASE` | No | Require lowercase (default: `true`) |
| `PASSWORD_REQUIRE_NUMBER` | No | Require digit (default: `true`) |
| `PASSWORD_REQUIRE_SPECIAL` | No | Require special char (default: `true`) |
| **Supabase only** | | |
| `SUPABASE_URL` | Conditional | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Conditional | Supabase service role key (admin operations) |
| **Auth0 only** | | |
| `AUTH0_DOMAIN` | Conditional | Auth0 domain (e.g. `org.us.auth0.com`) |
| `AUTH0_MGMT_CLIENT_ID` | Conditional | M2M client ID for Management API |
| `AUTH0_MGMT_CLIENT_SECRET` | Conditional | M2M client secret for Management API |
| `SEED_EMAIL` | Seed script only | Email for bootstrap super_admin |
| `SEED_PASSWORD` | Seed script only | Initial password for bootstrap super_admin |

---

## 20. Testing Strategy

**Unit tests** (`test/unit/`) — Vitest, no DB, no network:
- `token.service.test.ts` — JWT sign/verify round-trip, JWKS shape, refresh rotation, replay detection logic
- `user.service.test.ts` — CRUD logic, deactivation flow, location assignment; `AuthProvider` mocked via `vi.fn()`
- `api-key.service.test.ts` — key generation, hash, validation logic, `last_used_at` update behaviour
- `password-policy.test.ts` — all policy permutations (valid + invalid passwords for each rule)
- `providers/supabase.provider.test.ts` — Supabase SDK mocked; verifies correct SDK method calls
- `providers/auth0.provider.test.ts` — Auth0 SDK mocked; verifies Management API call shapes + token refresh

**Integration tests** (`test/integration/`) — Vitest + real PostgreSQL (test schema), Fastify inject (no network):
- `session.test.ts` — `POST /session`, `POST /refresh`, `DELETE /session`, replay detection, token cleanup
- `users.test.ts` — full CRUD lifecycle, deactivation, `422` re-activation, pagination cursor round-trip
- `api-keys.test.ts` — generate → list → validate → revoke lifecycle; `X-Internal-Secret` enforcement
- `me.test.ts` — profile fetch, password change (forced + voluntary flows), `must_change_password` 403 gate

**Auth provider smoke tests** (optional, `test/integration/providers/`) — tagged `@smoke`, skipped in CI by default. Hit real Supabase/Auth0 dev tenants. Run manually before provider upgrades.
