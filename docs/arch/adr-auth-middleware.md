# ADR: @ortho/auth-middleware — JWT Verification and RBAC Plugin

**Date:** 2026-04-03
**Status:** Accepted
**Package:** `packages/@ortho/auth-middleware`
**Spec:** `docs/superpowers/specs/2026-04-02-identity-service-updated-design.md` (§14)

---

## Context

Every Fastify service in the monorepo needs to verify caller identity and enforce access control before processing requests. The Identity Service issues RS256-signed JWTs carrying role and location claims. Rather than each service reimplementing JWT verification, JWKS caching, and RBAC, a shared Fastify plugin encapsulates these concerns.

The plugin is the primary consumer of the Identity Service's JWKS endpoint. It must:

- Verify every inbound JWT without a per-request round-trip to Identity Service
- Cache JWKS keys at startup and refresh on unknown `kid` (key rotation support)
- Attach the decoded user payload to `req.user` for downstream route handlers
- Gate password-change-required flows so forced resets cannot be bypassed
- Provide composable `preHandler` guards for permission, role, and location checks

---

## Decision

Provide `@ortho/auth-middleware` as a Fastify plugin registered once at server startup (`authPlugin`), plus three standalone `preHandler` factory functions (`requirePermission`, `requireRole`, `requireLocation`). Services import only what they need.

---

## Core Types

### `JwtPayload`

Decoded claims attached to every verified request. Available as `req.user` inside route handlers and `preHandler` hooks.

```ts
interface JwtPayload {
  sub: string;                // staff user UUID
  role: string;               // one of the five role values
  locations: string[];        // location UUIDs assigned to this user
  must_change_password: boolean;
}
```

**`locations` semantics by role:**

| Role | `locations` value | Interpretation |
|------|------------------|----------------|
| `call_center_agent` | `["loc-uuid"]` | Exactly one home location |
| `call_center_manager` | `["loc-a", "loc-b", ...]` | One or more assigned locations |
| `marketing_staff` | `[]` | Empty — treated as all locations |
| `marketing_manager` | `[]` | Empty — treated as all locations |
| `super_admin` | `[]` | Empty — bypasses all permission checks |

The plugin populates `req.user` but does not interpret `locations` semantics itself. `requireLocation()` applies the semantics above when evaluating access.

### Fastify module augmentation

The package augments Fastify's request type so `req.user` is available without casting throughout the service:

```ts
declare module 'fastify' {
  interface FastifyRequest {
    user?: JwtPayload;
  }
}
```

---

## API

### `authPlugin` — Fastify plugin

Register once on the Fastify instance at server startup. All routes registered after `authPlugin` will have JWT enforcement applied.

```ts
import { authPlugin } from '@ortho/auth-middleware';

await app.register(authPlugin, {
  jwksUrl: 'https://identity.internal/identity/.well-known/jwks.json',
  allowedPaths: [
    '/identity/session',
    '/identity/refresh',
    '/identity/.well-known/jwks.json',
    '/health',
  ],
});
```

**Options:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `jwksUrl` | `string` | Yes | URL of the Identity Service JWKS endpoint |
| `allowedPaths` | `string[]` | No | Exact paths (without query string) that bypass JWT verification. Defaults to `[]`. |

**Behaviour:**

1. Fetches JWKS at plugin registration. Startup fails if the endpoint cannot be reached within 3 attempts (exponential back-off: 1 s → 2 s → 4 s).
2. Installs an `onRequest` hook on the Fastify instance.
3. For every request not in `allowedPaths`:
   - Requires `Authorization: Bearer <token>` header — `401 { "error": "invalid_token" }` if absent or malformed.
   - Decodes the JWT header to extract `kid`, looks up the cached verifier — if `kid` is unknown, re-fetches JWKS once (max one re-fetch per 60 s window). Returns `503 { "error": "jwks_unavailable" }` if the re-fetch fails; `401` if `kid` is still not found.
   - Verifies the JWT signature (RS256). Returns `401` on any verification failure.
   - Attaches the decoded payload to `req.user`.
   - If `req.user.must_change_password === true`, returns `403 { "error": "password_change_required" }` **except** on these exact paths: `PUT /identity/me/password`, `GET /identity/me`, `DELETE /identity/session`.

**JWKS key rotation:** On each JWKS re-fetch the cache is rebuilt from scratch — keys no longer present in the JWKS response are evicted. This means retired keys are removed within one re-fetch cycle (triggered on the first request carrying a `kid` signed with the new key).

**Error responses:**

| Status | Body | Cause |
|--------|------|-------|
| `401` | `{ "error": "invalid_token" }` | Missing/malformed/expired JWT or unknown `kid` |
| `403` | `{ "error": "password_change_required" }` | `must_change_password: true` on a non-exempt route |
| `503` | `{ "error": "jwks_unavailable" }` | JWKS re-fetch failed on all retry attempts |

---

### `requirePermission(permission)` — preHandler

Guards a route by checking that the caller's role has the specified permission. `super_admin` bypasses the check unconditionally.

```ts
import { requirePermission } from '@ortho/auth-middleware';

app.get('/leads', { preHandler: requirePermission('leads:read') }, handler);
```

Returns `403 { "error": "forbidden" }` when the role lacks the permission.

---

### `requireRole(allowedRoles)` — preHandler

Guards a route by checking that the caller's role is in `allowedRoles`. Use for endpoints that are scoped to specific roles rather than capabilities.

```ts
import { requireRole } from '@ortho/auth-middleware';

app.post('/identity/users', { preHandler: requireRole(['marketing_manager', 'super_admin']) }, handler);
```

Returns `403 { "error": "forbidden" }` when the role is not in the allowed list.

---

### `requireLocation()` — preHandler

Guards a route by asserting the caller has access to the location referenced in the request. Reads `location_id` from route params first, then from the query string.

```ts
import { requireLocation } from '@ortho/auth-middleware';

app.get('/leads/:location_id', { preHandler: requireLocation() }, handler);
app.get('/conversations', { preHandler: requireLocation() }, handler); // uses ?location_id=
```

**Bypass roles:** `marketing_staff`, `marketing_manager`, `super_admin` always pass — their `locations: []` claim is interpreted as all-locations access.

Returns `403 { "error": "forbidden" }` when:
- `location_id` is not present in params or query string
- The resolved `location_id` is not in `req.user.locations`

---

### `ROLE_PERMISSIONS` — static map

Exported for services that need to inspect the permission model programmatically (e.g., building OpenAPI security schemes or seeding test fixtures). Not intended for runtime guard logic — use `requirePermission()` instead.

```ts
import { ROLE_PERMISSIONS } from '@ortho/auth-middleware';
```

| Role | Permissions |
|------|-------------|
| `call_center_agent` | `leads:read`, `conversations:read`, `conversations:write`, `pipeline:read` |
| `call_center_manager` | All agent permissions + `leads:write`, `pipeline:write`, `reports:read` |
| `marketing_staff` | `leads:read`, `leads:write`, `campaigns:read`, `campaigns:write`, `reports:read` |
| `marketing_manager` | All of the above + `conversations:read/write`, `pipeline:read/write`, `users:read/write`, `api-keys:read/write` |
| `super_admin` | All permissions (same set as `marketing_manager`; bypasses `requirePermission` check entirely) |

---

## Examples

### 1. Register the plugin on a service

Register `authPlugin` before any routes. Pass all public paths (login, health, JWKS) in `allowedPaths`.

```ts
// apps/crm/lead/src/index.ts
import Fastify from 'fastify';
import { authPlugin } from '@ortho/auth-middleware';
import { leadRoutes } from './routes/leads.js';

const app = Fastify({ logger: true });

await app.register(authPlugin, {
  jwksUrl: process.env.IDENTITY_JWKS_URL!,
  allowedPaths: ['/health'],
});

await app.register(leadRoutes);
await app.listen({ port: 3000 });
```

---

### 2. Protect a route with a permission check

Any route needing the caller to hold a specific capability uses `requirePermission`. The guard runs after JWT verification attaches `req.user`.

```ts
// apps/crm/lead/src/routes/leads.ts
import type { FastifyPluginAsync } from 'fastify';
import { requirePermission } from '@ortho/auth-middleware';

export const leadRoutes: FastifyPluginAsync = async (app) => {
  app.get('/leads', { preHandler: requirePermission('leads:read') }, async (req) => {
    return leadService.list({ userId: req.user!.sub });
  });

  app.post('/leads', { preHandler: requirePermission('leads:write') }, async (req) => {
    return leadService.create(req.body);
  });
};
```

---

### 3. Restrict an endpoint to specific roles

Use `requireRole` when the restriction is about identity, not capability. Example: only managers and super admins can create users.

```ts
// apps/platform/identity/src/routes/users.ts
import { requireRole } from '@ortho/auth-middleware';

app.post('/identity/users',
  { preHandler: requireRole(['marketing_manager', 'super_admin']) },
  async (req) => {
    return userService.create(req.body);
  },
);
```

---

### 4. Enforce location scoping on a multi-location resource

When agents may only access leads in their home location, `requireLocation` checks the `location_id` route param against `req.user.locations`. Marketing roles and super_admin bypass the check automatically.

```ts
// apps/crm/conversation/src/routes/conversations.ts
import { requirePermission, requireLocation } from '@ortho/auth-middleware';

// Both guards run; requireLocation runs second so req.user is guaranteed to exist
app.get('/conversations',
  { preHandler: [requirePermission('conversations:read'), requireLocation()] },
  async (req) => {
    const locationId = (req.query as { location_id: string }).location_id;
    return conversationService.list({ locationId });
  },
);
```

---

### 5. Combining multiple preHandlers

`preHandler` accepts an array. Guards run in order; the first rejection short-circuits the chain.

```ts
app.put('/pipeline/transitions',
  {
    preHandler: [
      requirePermission('pipeline:write'),
      requireLocation(),
    ],
  },
  async (req) => {
    return pipelineService.transition(req.body);
  },
);
```

---

### 6. Accessing `req.user` inside a handler

After the plugin runs, `req.user` is populated for all non-bypassed routes. It is typed as `JwtPayload | undefined` — use the non-null assertion (`!`) only after a guard has already enforced authentication.

```ts
app.get('/me', async (req) => {
  const { sub, role, locations } = req.user!;
  return { id: sub, role, locations };
});
```

---

### 7. Unit testing routes without a live Identity Service

Bypass JWKS by injecting a pre-built JWT directly into the request in integration tests via Fastify's `inject()` API. Use the same private key that `scripts/generate-dev-keys.ts` writes to `.env`.

```ts
// test/integration/leads.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { buildApp } from '../../src/index.js';
import { createSigner } from 'fast-jwt';
import { readFileSync } from 'node:fs';

const privateKey = readFileSync('.env.test.key', 'utf8');
const sign = createSigner({ algorithm: 'RS256', key: privateKey, kid: 'test-1' });

function makeToken(overrides: Partial<JwtPayload> = {}): string {
  return sign({
    sub: 'user-uuid-1',
    role: 'call_center_agent',
    locations: ['loc-uuid-1'],
    must_change_password: false,
    ...overrides,
  });
}

describe('GET /leads', () => {
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    app = buildApp(); // registers authPlugin pointing at test JWKS
    await app.ready();
  });

  it('returns 200 for a call_center_agent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/leads',
      headers: { authorization: `Bearer ${makeToken()}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 403 when agent lacks write permission', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/leads',
      headers: { authorization: `Bearer ${makeToken()}` },
      payload: { name: 'Jane' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('returns 403 when must_change_password is true', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/leads',
      headers: { authorization: `Bearer ${makeToken({ must_change_password: true })}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'password_change_required' });
  });
});
```

---

## Constraints and Gotchas

- **Register before routes.** `authPlugin` installs an `onRequest` hook on the Fastify instance. Routes registered before the plugin will not have JWT enforcement.
- **`allowedPaths` is exact-match, no query string.** The check strips the query string and compares the path string exactly. `/health?verbose=true` matches `/health` in the list. `/leads/123` does not match `/leads`.
- **`requireLocation` reads one `location_id`.** It looks for `req.params.location_id` first, then `req.query.location_id`. If your route uses a different param name, the guard will always return `403` for non-bypass roles.
- **`super_admin` bypasses `requirePermission` but not `requireRole`.** `requireRole(['marketing_manager'])` will reject a `super_admin`. If you want to include super admins, add them to the list explicitly.
- **`must_change_password` exempt paths are hardcoded.** The three exempt paths (`PUT /identity/me/password`, `GET /identity/me`, `DELETE /identity/session`) are defined inside the plugin. They cannot be extended by consumers. This is intentional — only the Identity Service itself should use those paths.
- **Outstanding JWTs remain valid up to 15 minutes after deactivation.** The plugin verifies the JWT signature and expiry only — it does not call back to Identity Service per request. A deactivated user's existing JWT continues to work until it expires naturally.
- **JWKS re-fetch is rate-limited.** At most one re-fetch per 60 seconds. During a key rotation, the first request with the new `kid` triggers a re-fetch; subsequent requests with unknown `kid` within the 60 s window will receive `401`.
- **Startup failure on JWKS unavailability.** If `fetchJwksWithRetry` fails all 3 attempts at registration time, the plugin throws and the service will not start. This is intentional — a service that cannot verify tokens should not accept traffic.

---

## Consequences

**Good:**
- JWT verification and RBAC are implemented once and shared across all 20 consuming services. A security fix or policy change (e.g., adding a new role) requires updating only this package.
- No per-request call to Identity Service under normal operation. JWKS keys are cached for the process lifetime and refreshed only on unknown `kid`.
- Key rotation is transparent to services — the plugin evicts retired keys automatically on re-fetch.

**Watch out for:**
- Services must point `jwksUrl` at the correct endpoint. In local dev, this is typically `http://localhost:3001/identity/.well-known/jwks.json`. In production, use the internal VPC DNS name — not the public ALB URL.
- Do not register `authPlugin` multiple times on the same Fastify instance. `fastify-plugin` disables encapsulation, so the `onRequest` hook would fire twice per request.
- When writing integration tests, ensure the test JWKS server (or static key file) uses the same `kid` as the tokens being signed. A mismatch causes the plugin to attempt a re-fetch on every request, adding latency to the test suite.
