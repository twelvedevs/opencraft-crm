# Identity Service — Design Spec

**Date:** 2026-03-25
**Status:** Draft
**Scope:** Platform-layer Identity Service — authentication, enriched JWT issuance, RBAC, user management, API key management

---

## 1. Overview

The Identity Service is a **platform-layer service** (`apps/platform/identity`) that owns the canonical user record, issues enriched JWTs consumed by every other service, and manages staff accounts and API keys. It is shared across all products in the deployment — Ortho CRM and the future EHR consume the same Identity Service instance.

**Core responsibilities:**
- Exchange auth provider tokens for enriched JWTs carrying role and location claims
- Issue and rotate refresh tokens
- Serve a JWKS endpoint for distributed JWT verification across all services
- Own the user record: create, update, deactivate staff accounts
- Manage location assignments per user
- Generate and validate simple long-lived API keys for EHR integration

**Out of scope:**
- Raw credential storage (passwords, OAuth tokens) — delegated to auth provider
- Session UI — frontend handles login form and token storage directly
- Fine-grained permission customization per user — permissions are role-based only

---

## 2. Architecture

```
                     ┌──────────────────────────────────────────────┐
                     │           Auth Provider                       │
                     │  (Supabase Auth or Auth0 — pluggable)        │
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
│  3. Issue signed enriched JWT (RS256, 15min TTL)                     │
│  4. Issue refresh token (SHA256-hashed, stored, 30-day TTL)          │
│       │                                                               │
│       ▼                                                               │
│  Enriched JWT ──────────────────────────────────────────────────►    │
│                                     All services verify via JWKS     │
│  GET /.well-known/jwks.json ◄──── @ortho/auth-middleware (cached)   │
│                                                                       │
│  REST API (Fastify)                                                   │
│  /identity/session        auth flow                                   │
│  /identity/me             own profile + password change              │
│  /identity/users          staff CRUD (Marketing Manager+ only)       │
│  /identity/api-keys       key management (Marketing Manager+ only)   │
└──────────────────────────────────────────────────────────────────────┘
              │
     platform_identity schema (PostgreSQL)
```

**Login flow:**
1. Frontend submits credentials directly to the auth provider — Identity Service never sees raw passwords
2. Auth provider validates credentials, returns a short-lived provider token
3. Frontend calls `POST /identity/session` with the provider token
4. Identity Service validates the token via the `AuthProvider` interface, loads the user's role and location assignments from its own DB, and issues a signed enriched JWT (15-minute TTL) + a refresh token (30-day TTL)
5. All subsequent API calls carry the enriched JWT — no further Identity Service round-trips per request

**JWT verification across services:** Every service verifies JWTs locally using Identity Service's JWKS endpoint (`GET /identity/.well-known/jwks.json`). `@ortho/auth-middleware` fetches and caches the JWKS at startup. On receiving a JWT with a `kid` not present in the local cache, the middleware immediately re-fetches the JWKS endpoint (once, with exponential back-off on failure to prevent thundering herd during rotation). No per-request call to Identity Service under normal operation.

**Auth provider abstraction:** A `AuthProvider` interface sits between Identity Service and the credential backend. Supabase Auth and Auth0 are two concrete implementations. Switching providers is a config change (`AUTH_PROVIDER=supabase|auth0`), not a service change.

---

## 3. JWT Claims

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

**Permission resolution:** Permissions are purely role-based. `@ortho/auth-middleware` holds a static `ROLE_PERMISSIONS` constant mapping each role to its allowed permission strings (sourced from the PRD permission table). Permissions are resolved at request time from the `role` claim — not stored in the JWT. Permission changes for a role require a deploy and a shared package version bump.

**Location enforcement pattern** (consistent with Notification Service spec):
- `location:{id}` — middleware checks that `id` is in the JWT `locations` array, or that the role is `marketing_staff` / `marketing_manager` / `super_admin`
- `user:{id}` — middleware checks that `id` matches `sub`

**`must_change_password`:** Set to `true` on account creation. The frontend intercepts this claim and gates all navigation behind the password-change screen. Server-side, `@ortho/auth-middleware` also enforces this: any JWT with `must_change_password: true` is rejected with `403 { "error": "password_change_required" }` on all endpoints **except** `PUT /identity/me/password`, `GET /identity/me`, and `DELETE /identity/session` (a user must be able to log out even before changing their password). This prevents bypassing the frontend gate via direct API calls. Cleared on successful `PUT /identity/me/password`.

**Signing algorithm:** RS256, RSA-2048. The private key is loaded from `IDENTITY_PRIVATE_KEY` env var. Each key pair carries a `kid` (key ID) that is embedded in the JWT header and included in the JWKS response. `@ortho/auth-middleware` selects the matching key from its JWKS cache using `kid`.

**Key rotation procedure:** (1) Generate a new key pair and add it to `IDENTITY_JWKS_KEYS` env var alongside the existing key. (2) Deploy — JWKS now serves both keys; all services pick up the new key on their next JWKS refresh. (3) New JWTs are signed with the new `kid`; old JWTs (signed with the old `kid`) continue to verify correctly for up to their 15-minute TTL. (4) After 15 minutes, remove the old key from `IDENTITY_JWKS_KEYS` and redeploy. At no point are valid tokens rejected.

---

## 4. Database Schema (`platform_identity`)

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
created_by           uuid         REFERENCES users(id) NULLABLE  -- null for bootstrap super_admin
created_at           timestamptz  NOT NULL DEFAULT now()
updated_at           timestamptz  NOT NULL DEFAULT now()
```

When EHR roles are added, extend the `CHECK` constraint via migration. A `CHECK` constraint is used rather than a Postgres `ENUM` type because it is simpler to extend with `ALTER TABLE`.

### `user_locations`

```sql
user_id     uuid  REFERENCES users(id) ON DELETE CASCADE
location_id uuid  NOT NULL
PRIMARY KEY (user_id, location_id)
```

Not populated for `marketing_staff`, `marketing_manager`, `super_admin` — those roles receive an empty `locations[]` in the JWT.

### `refresh_tokens`

```sql
id           uuid         PRIMARY KEY DEFAULT gen_random_uuid()
user_id      uuid         REFERENCES users(id) ON DELETE CASCADE
token_hash   varchar      UNIQUE NOT NULL  -- SHA256 of the raw token
expires_at   timestamptz  NOT NULL
revoked_at   timestamptz  NULLABLE
created_at   timestamptz  NOT NULL DEFAULT now()
```

Rotation on use: each `POST /identity/refresh` revokes the presented token and issues a new one.

**Replay detection:** If `POST /identity/refresh` is called with a token whose `revoked_at IS NOT NULL`, this signals possible token theft. All refresh tokens for the associated `user_id` are immediately revoked and a `401 { "error": "session_invalidated" }` is returned. The user must log in again from scratch.

**Cleanup:** A daily BullMQ job prunes rows where `expires_at < now() OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')`. Both expired and old revoked tokens are removed.

### `api_keys`

```sql
id           uuid         PRIMARY KEY DEFAULT gen_random_uuid()
name         varchar      NOT NULL
key_hash     varchar      UNIQUE NOT NULL  -- SHA256 of raw key (prefix: ak_)
permissions  varchar[]    NOT NULL          -- e.g. ['leads:read', 'pipeline:write']
created_by   uuid         REFERENCES users(id)
created_at   timestamptz  NOT NULL DEFAULT now()
last_used_at timestamptz  NULLABLE
revoked_at   timestamptz  NULLABLE
```

Raw key returned once on creation, never stored. Key format: `ak_<32 random bytes hex>`.

---

## 5. API

### Auth Flow

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/identity/session` | None | Exchange provider token → enriched JWT + refresh token. Rate-limited at the load balancer (max 10 req/min per IP). |
| `POST` | `/identity/refresh` | None | Exchange refresh token → new JWT + new refresh token (rotation). Body: `{ "refresh_token": "<raw>" }`. Rate-limited at load balancer. |
| `DELETE` | `/identity/session` | JWT | Logout — body: `{ "refresh_token": "<raw>" }`. Revokes only the presented token (single-device logout). |
| `GET` | `/identity/.well-known/jwks.json` | None | Public key set for JWT verification |
| `GET` | `/identity/me` | JWT | Own profile — returns `{ id, email, name, role, locations, force_password_reset, status }`. Note: `force_password_reset` in the REST response is the same flag as `must_change_password` in the JWT — different names for the same concept (DB column name vs JWT claim name). |
| `PUT` | `/identity/me/password` | JWT | Body: `{ "current_password": "...", "new_password": "..." }`. When `must_change_password` is `false`: `current_password` is required and verified via `AuthProvider` before the update. When `must_change_password` is `true` (forced-reset flow): `current_password` is omitted from the request; Identity Service calls `AuthProvider.setPassword()` directly without verifying the existing credential. Accepted risk: a stolen JWT within its 15-min TTL can hijack a new account before the legitimate user first logs in. Returns `200 {}` on success; clears `force_password_reset`. |

### User Management — `require-role(['marketing_manager', 'super_admin'])`

| Method | Path | Description |
|---|---|---|
| `POST` | `/identity/users` | Create user with initial password; `force_password_reset: true` |
| `GET` | `/identity/users` | List users; filterable by `role`, `status`; cursor-paginated (default page size: 50) |
| `GET` | `/identity/users/:id` | Get user |
| `PUT` | `/identity/users/:id` | Update name, role, location assignments, or status. When `status` is set to `inactive`: all active refresh tokens for that user are bulk-revoked (`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = :id AND revoked_at IS NULL`) and `AuthProvider.deactivateUser()` is called. Outstanding JWTs remain valid for up to 15 minutes — accepted consequence of the stateless JWT model. |
| `PUT` | `/identity/users/:id/password` | Admin password reset. Automatically sets `force_password_reset = true`. No notification is sent — the admin communicates the new password out-of-band. |

### API Key Management — `require-role(['marketing_manager', 'super_admin'])`

| Method | Path | Description |
|---|---|---|
| `POST` | `/identity/api-keys` | Generate key; returns raw key once |
| `GET` | `/identity/api-keys` | List keys (name, permissions, last_used_at, status) |
| `DELETE` | `/identity/api-keys/:id` | Revoke key |
| `POST` | `/identity/api-keys/validate` | **Internal VPC-only** — not exposed on the public ALB. Protected by a pre-shared `INTERNAL_API_SECRET` env var (same value set on both Identity Service and CRM API Gateway); caller passes it as `X-Internal-Secret: <secret>`. Validates an `ak_` key passed in the request body; returns `{ "permissions": [...] }` or `401`. CRM API Gateway caches valid responses for 60s. Updates `last_used_at` on cache misses only — not on every API call. |

### Response shapes

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

**Error shape** (consistent with other platform services):
```json
{ "error": "<message>" }
```

---

## 6. Internal Service Structure

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
│   │   ├── token.service.ts     # JWT sign, JWKS serving, refresh token rotation
│   │   ├── user.service.ts      # user CRUD, location assignment
│   │   └── api-key.service.ts   # key generation, hash, validation
│   ├── repositories/
│   │   ├── user.repo.ts
│   │   ├── refresh-token.repo.ts
│   │   └── api-key.repo.ts
│   ├── providers/
│   │   ├── auth-provider.interface.ts   # verifyToken, createUser, setPassword, deactivateUser
│   │   ├── supabase.provider.ts
│   │   └── auth0.provider.ts
│   ├── jobs/
│   │   └── cleanup.job.ts       # daily BullMQ job: prune expired and old revoked refresh tokens
│   └── index.ts
├── migrations/
├── test/
├── Dockerfile
├── package.json
└── tsconfig.json
```

### `packages/@ortho/auth-middleware`

Fastify plugin consumed by all services. Exposes:

```
src/
├── plugin.ts              # verifies JWT via JWKS (caches keys, selects by kid),
│                          # attaches user context to request;
│                          # rejects must_change_password: true with 403 on all routes
│                          # except PUT /identity/me/password and GET /identity/me
├── permissions.ts         # static ROLE_PERMISSIONS map (from PRD permission table)
├── require-permission.ts  # preHandler: checks ROLE_PERMISSIONS[role].includes(permission)
│                          # → 403 if not found. Primary enforcement mechanism for
│                          # fine-grained permissions (e.g. 'leads:write', 'bulk_sms:send')
├── require-role.ts        # preHandler: enforce minimum role level
│                          # (used for admin-only endpoints where role itself is the gate)
└── require-location.ts    # preHandler: enforce location claim contains :id,
                           # or role is marketing_staff / marketing_manager / super_admin
```

---

## 7. Auth Provider Abstraction

```typescript
interface AuthProvider {
  // Validates a provider-issued token; returns provider user ID + email on success
  verifyToken(token: string): Promise<{ providerUserId: string; email: string }>

  // Creates a credential record in the auth provider
  createUser(email: string, password: string): Promise<{ providerUserId: string }>

  // Updates the credential password
  setPassword(providerUserId: string, password: string): Promise<void>

  // Disables login for this credential (does not delete)
  deactivateUser(providerUserId: string): Promise<void>
}
```

**Selecting the provider:** `AUTH_PROVIDER` env var (`supabase` | `auth0`). Both implementations are bundled; the active one is instantiated at startup. No code change required to switch.

**Auth0 specifics:** Uses Auth0 Management API for `createUser` / `setPassword` / `deactivateUser`. `verifyToken` validates the Auth0 access token against Auth0's JWKS.

**Supabase Auth specifics:** Uses Supabase Admin API. `verifyToken` validates via `supabase.auth.getUser(token)`. Password operations use `supabase.auth.admin.*`.

---

## 8. No Events Published

Identity Service publishes no EventBridge events. User creation and role changes are synchronous management operations — no other service needs to react to them in real time. Downstream services re-read claims on next token issue.

---

## 9. Key Constraints

- **Multi-location native:** All 34 locations represented as UUIDs in `user_locations`. Location IDs are owned by the CRM product layer and referenced here as opaque UUIDs. **Identity Service does not validate location IDs** — it stores whatever UUIDs are passed by the caller. The product layer is responsible for passing correct IDs. Invalid location UUIDs in `user_locations` result in empty or incorrect `locations[]` claims in JWTs; this is a caller error, not an Identity Service error.

- **API keys are not location-scoped.** A key with `leads:read` permission can read leads across all locations. Scoping is by permission string only.

- **EHR SSO:** When the EHR launches, it joins the same Identity Service deployment. EHR staff roles are added by extending the `CHECK` constraint via migration and bumping `@ortho/auth-middleware` (new role → permissions mapping). The `AuthProvider` tenant is shared, enabling single sign-on across both products.

- **No PHI at launch:** User records contain staff PII only (name, email). No patient data is stored in `platform_identity`.

- **Bootstrap:** A standalone seed script at `apps/platform/identity/scripts/seed-super-admin.ts` creates the first `super_admin`. It reads `SEED_EMAIL` and `SEED_PASSWORD` from env vars, calls `AuthProvider.createUser()`, then inserts the `users` row directly into the DB with `force_password_reset = true` and `created_by = NULL`. The raw password is never stored. After first login, the super_admin must change their password before accessing any other endpoint (enforced server-side by `@ortho/auth-middleware`).
