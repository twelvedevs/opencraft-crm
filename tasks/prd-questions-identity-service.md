# Clarifying Questions: Identity Service

> Original request: Generate PRD for the Identity Service as specified in `docs/superpowers/specs/2026-03-25-identity-service-design.md` — authentication, enriched JWT issuance, RBAC, user management, and API key management for the Ortho CRM platform.

## Questions

1. Which auth provider implementation(s) should be in scope for this initial build?
   A. Supabase Auth only (Auth0 stub can be added later)
   B. Auth0 only (Supabase stub can be added later)
   C. Both Supabase and Auth0 fully implemented from the start
   D. Just the `AuthProvider` interface + one concrete implementation; second can be empty/stub

   **Answer:** C

2. Should `packages/@ortho/auth-middleware` be built as part of this Identity Service PRD, or is it a separate delivery?
   A. Yes — include it as stories within this same PRD (it's the primary consumer-facing output)
   B. No — it's a separate PRD; this PRD covers only `apps/platform/identity`
   C. Include a minimal version (JWT verification + `requirePermission`) in this PRD; advanced features (requireRole, requireLocation, must_change_password enforcement) come later

   **Answer:** A

3. What JWT signing library should be used for RS256 issuance and JWKS serving?
   A. `jose` (Web Crypto API, supports JWKS natively, zero native deps)
   B. `fast-jwt` (consistent with integration-hub which uses it for verification)
   C. `jsonwebtoken` + `jwks-rsa` (battle-tested, more dependencies)
   D. Other: [please specify]

   **Answer:** B

4. How should the auth provider be tested — specifically `verifyToken`, `createUser`, `setPassword`, `deactivateUser`?
   A. Mock the provider SDK in unit tests; no live calls
   B. Integration tests against a real Supabase/Auth0 dev tenant
   C. Mock in unit tests; a separate optional integration test suite for provider smoke tests
   D. Use a local Supabase Docker container for integration tests

   **Answer:** C

5. The spec says `POST /identity/session` and `POST /identity/refresh` are rate-limited "at the load balancer." Should the service also implement application-level rate limiting (e.g. via `@fastify/rate-limit`) for local dev / pre-ALB environments?
   A. No — trust ALB entirely; no `@fastify/rate-limit` in the service
   B. Yes — add `@fastify/rate-limit` as a defence-in-depth layer (same limits as spec: 10 req/min per IP)
   C. Yes — but only as a configurable opt-in via env var (`RATE_LIMIT_ENABLED=true`)

   **Answer:** A

6. For `GET /identity/users` cursor pagination, what format should the cursor use?
   A. Opaque base64-encoded `{ created_at, id }` cursor (consistent with other services)
   B. Numeric offset (simpler, less correct for concurrent inserts)
   C. `created_at` ISO timestamp only
   D. Keyset on `id` (UUID, not naturally ordered) — not recommended

   **Answer:** A

7. How should `IDENTITY_PRIVATE_KEY` and `IDENTITY_JWKS_KEYS` be structured for local development?
   A. Pre-generated RSA keys committed to `.env.example` (dev keys only, clearly marked)
   B. A `scripts/generate-dev-keys.ts` script that creates `.env.local` with fresh keys
   C. Rely on `EnvSecretsProvider` pattern consistent with integration-hub (values in `.env`)
   D. Other: [please specify]

   **Answer:** B + support C

8. The spec says re-activating an inactive user (`PUT /identity/users/:id` with `status: active`) returns `422` and is out of scope for launch. Should the endpoint still accept the request body field (and reject it), or should `status` be a write-once field at the validation layer?
   A. Accept `status` in the body; return `422` with `{ "error": "reactivation_not_supported" }` if inactive user
   B. Omit `status` from the `PUT /identity/users/:id` TypeBox schema entirely (can't be sent at all)
   C. Accept `status` only for the `inactive` transition; `active` is rejected at validation with `400`

   **Answer:** A

9. The `POST /identity/api-keys/validate` endpoint is VPC-only, protected by `X-Internal-Secret`. How should this be enforced in the service itself (beyond ALB/VPC rules)?
   A. Fastify `preHandler` that checks `req.headers['x-internal-secret'] === INTERNAL_API_SECRET`
   B. Separate Fastify instance on a different port (e.g. 3001) for internal endpoints only
   C. Trust VPC/ALB entirely — no application-level enforcement in the service code
   D. Middleware that also checks the request IP is in an allowed CIDR range

   **Answer:** A

10. The spec says `PUT /identity/me/password` with `must_change_password: true` skips `current_password` verification. Should this behaviour be enforced via TypeBox schema (making `current_password` optional with conditional logic) or at the service layer only?
    A. TypeBox schema makes `current_password` always optional; service layer decides whether to use it
    B. Two distinct request shapes validated at the schema level (`current_password` required vs absent)
    C. Single schema with `current_password` optional; service layer reads `must_change_password` from JWT claim to decide

    **Answer:** A

11. Should the BullMQ cleanup job (`cleanup.job.ts`) connect to the same Redis instance used by other platform services, or does the Identity Service maintain its own Redis connection?
    A. Shared Redis — connect to the same `REDIS_URL` used monorepo-wide
    B. Identity Service owns its Redis connection via its own `REDIS_URL` env var
    C. No preference — follow whatever pattern the most recently built service (integration-hub) uses

    **Answer:** A

12. Password strength enforcement: does the Identity Service validate `new_password` complexity (length, character classes) or is that entirely delegated to the auth provider?
    A. Fully delegated — auth provider enforces its own rules; Identity Service passes the password through
    B. Identity Service applies a minimum length check (e.g. ≥ 12 chars) before calling the provider
    C. Identity Service validates against a configurable policy (length + complexity) independent of the provider

    **Answer:** C

13. For the seed script (`scripts/seed-super-admin.ts`), should it be idempotent (safe to run multiple times) or a one-shot script that errors if a super_admin already exists?
    A. One-shot — errors with a clear message if `super_admin` already exists in the DB
    B. Idempotent — upserts the super_admin row; safe to re-run without side effects
    C. Idempotent for the DB row; errors if `AuthProvider.createUser` fails due to duplicate email

    **Answer:** C

14. The `@ortho/logger` ADR specifies `createLogger('identity')` as the pattern. Should the Identity Service also use child loggers for request-scoped context (binding `requestId`, `userId`) as shown in the ADR examples?
    A. Yes — child loggers in route handlers binding `{ requestId: req.id, userId: req.user?.sub }`
    B. No — a single service-level logger is sufficient for this service
    C. Yes, but only bind `requestId` (avoid logging `userId` to reduce PII surface)

    **Answer:** A

15. What is the minimum test coverage expectation for this service?
    A. Unit tests for services + repositories only; no integration tests in this PRD
    B. Unit tests for services/repositories + integration tests for the full HTTP layer (Fastify inject)
    C. Same as integration-hub: unit tests for business logic, integration tests for event routing → handler → DB and HTTP endpoint suite
    D. Just enough tests for Ralph to mark `passes: true` — no explicit coverage target

    **Answer:** B

16. CORS: the spec says the frontend calls `POST /identity/session` directly (not via the CRM API Gateway). Should the Identity Service configure CORS to accept browser requests from the CRM web app origin?
    A. Yes — `@fastify/cors` with allowed origin set via `CORS_ORIGIN` env var
    B. No — CORS is handled at the ALB/CloudFront layer; the service itself needs no CORS plugin
    C. Yes — but allow all origins in dev (`*`), locked down via env var in production

    **Answer:** A
