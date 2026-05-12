# Clarifying Questions: Referral Service

> Original request: Generate implementation-ready PRD for the Referral Service
> (`apps/crm/referral`) based on `docs/superpowers/specs/2026-03-25-referral-service-design.md`.

---

## Questions

### Package Integration

1. The spec says "SQS worker pattern identical to Lead Service — EventBridge → SQS queue → BullMQ worker → typed handlers." The actual Lead Service implementation uses `@ortho/event-bus` `.subscribe()` + `.start()` (EventBridgeDriver handles SQS polling internally — no separate BullMQ queue, no Redis). The Campaign Service uses the same pattern. Should the Referral Service follow this same `@ortho/event-bus` subscribe approach, or does the spec intend a distinct BullMQ-on-SQS worker (requiring Redis and an additional BullMQ queue)?

   A. Use `@ortho/event-bus` `.subscribe()` + `.start()` — identical to Lead Service and Campaign Service actual implementations. No Redis, no BullMQ queue needed.
   B. Use a custom BullMQ worker that reads from SQS directly, separate from `@ortho/event-bus`. This would require Redis and is a distinct pattern from other services.

   **Answer:** A

2. The `@ortho/types` `LeadConvertedPayload` only has `{ lead_id, location_id, channel }` — it is missing `to_pipeline` and `converted_at` which the `lead-converted.ts` handler branches on. The Pipeline Engine publisher confirms these fields exist at runtime. Similarly, `@ortho/types` `LeadStageChangedPayload` has `occurred_at` but the Pipeline Engine publisher uses `transitioned_at`. Should the Referral Service implementation update `@ortho/types` to match the actual runtime shapes, or define local inline types that extend/override the shared ones?

   A. Update `@ortho/types` as part of the Referral Service implementation: fix `LeadStageChangedPayload` (`occurred_at` → `transitioned_at`), extend `LeadConvertedPayload` with the full pipeline publisher shape, and add `ReferralConvertedPayload` (with `referral_id`, `converted_at`) + `ReferrerCreatedPayload/Event`.
   B. Define local types inside the Referral Service for the fields it needs; leave `@ortho/types` for a separate cleanup task.
   C. Update `@ortho/types` only for the two new outgoing event types (`ReferralConvertedPayload`, `ReferrerCreatedPayload`); use local casting (`payload as unknown as X`) for the incoming events where the shared types are stale.

   **Answer:** A

3. `@ortho/auth-middleware`'s `ROLE_PERMISSIONS` has no `referrals:*` permissions. The spec says "Any staff" for read endpoints and "Marketing Staff+" for write/manage endpoints. Which RBAC approach should the Referral Service use?

   A. Add `referrals:read` and `referrals:write` to `ROLE_PERMISSIONS` (for all five roles appropriately) as part of this implementation, then use `requirePermission('referrals:read')` / `requirePermission('referrals:write')` on routes — consistent with how other services gate their routes.
   B. Use `requireRole(['call_center_agent', 'call_center_manager', 'marketing_staff', 'marketing_manager', 'super_admin'])` for reads and `requireRole(['marketing_staff', 'marketing_manager', 'super_admin'])` for writes — no `ROLE_PERMISSIONS` update needed.
   C. Use `requirePermission` with existing permissions (e.g. `leads:read` stands in for "any staff") — avoids adding new permissions but is semantically incorrect.

   **Answer:** A

4. The spec has three public routes (no JWT required): `GET /referrals/r/:code`, `GET /referrals/links/:code`, and `GET /referrals/portal/:token`. The `authPlugin` `allowedPaths` uses exact string matching only — `/referrals/r/:code` will not match a request path like `/referrals/r/abc123XY`. How should public route auth bypass be implemented?

   A. Register public routes on the Fastify instance **before** `authPlugin` registration — per the ADR: "routes registered before the plugin will not have JWT enforcement."
   B. Register public routes under a separate Fastify sub-app / encapsulated scope that does not have `authPlugin` registered.
   C. Use a custom `onRequest` hook on public routes that short-circuits before the `authPlugin` hook runs.

   **Answer:** B

---

### Event Handler Correctness

5. The `lead-stage-changed.ts` handler spec (Section 6.2) says `exam_scheduled_at = payload.transitioned_at`. The actual Pipeline Engine publisher emits `transitioned_at`. However, `@ortho/types` `LeadStageChangedPayload` has `occurred_at` instead. Which field name should the handler read from the incoming `lead.stage_changed` payload?

   A. `transitioned_at` — matches the actual Pipeline Engine publisher output. The `@ortho/types` field name `occurred_at` is a stale type definition that should be corrected separately.
   B. `occurred_at` — match `@ortho/types` as the source of truth; assume the Pipeline Engine will be updated.

   **Answer:** A

6. Section 6.2 describes the `lead-converted.ts` handler branching on `payload.to_pipeline`. The actual Pipeline Engine publisher also emits `converted_at` (timestamp of conversion). The handler in Branch A sets `converted_at` on the `referrals` row and in the `referral.converted` event payload. Should `converted_at` be read from `payload.converted_at` (set by the Pipeline Engine publisher), or should it default to `new Date()` in the handler?

   A. Read from `payload.converted_at` — the Pipeline Engine sets it, and using it preserves the correct conversion timestamp across services.
   B. Default to `new Date()` inside the handler — consistent with how other handlers in Lead Service set `occurred_at`.

   **Answer:** A

7. Section 8 (Integration Tests) describes a test case: "fallback to active link when code not in DB". However, Section 6.2 (`lead-created.ts` handler) explicitly says: **"Do not fall back to the active link"** and "code not found in DB → log warn + skip." These two statements contradict each other. Which behavior should the implementation follow?

   A. **No fallback** — if `referral_code` resolves to no row in `referral_links`, log warn and skip the referral record creation. The integration test description in Section 8 is a documentation error and should be ignored.
   B. **Fallback to active link** — if the code is not found, look up the referrer's active link and use that `referral_link_id`. Section 6.2's "no fallback" text is the error.

   **Answer:** A

8. The spec (Section 3 and 6.2) says the `lead-created.ts` handler "must not be shipped until Pending Amendment 1 (Lead Service spec) is implemented." Checking the codebase: `@ortho/types` `LeadCreatedPayload` already has `referrer_id?`, `referrer_type?`, `referral_code?` as optional fields, and the Lead Service publisher already emits them. The contract test in Section 8 is supposed to fail at deploy time if these fields are absent. Given that the fields appear to already be implemented, should the `lead-created.ts` handler be:

   A. Implemented fully from day one — the Lead Service amendment appears to already be in place; the contract test validates it at test time and the handler is not blocked.
   B. Implemented but gated behind a feature flag or skipped in an early phase; the contract test must still be written and must pass before the handler is activated.
   C. Implemented fully, but the contract test should assert the fields are **non-null** (not just present) to confirm actual attribution data flows through — blocking deployment if the Lead Service sends nulls.

   **Answer:** A

---

### Testing

9. The spec calls for integration tests with "real Postgres, Messaging Service + Lead Service mocked." What mocking approach should be used for the external HTTP calls to Messaging Service (`POST /messages/send`) and Lead Service (`GET /leads/:id`)?

   A. Use `nock` to intercept `node:http`/`node:https` calls at the module level — same pattern as other services in this repo that mock HTTP dependencies.
   B. Spin up lightweight Fastify mock servers inside the test setup (in-process) — avoids `nock`'s patching of globals.
   C. Use `vi.mock` (Vitest) to mock the client modules (`lead-service.client.ts`, the Messaging Service fetch wrapper) directly — no HTTP at all in integration tests for external calls.

   **Answer:** c

10. The spec requires a contract test that "must fail if the Lead Service amendment has not been deployed." Given that `@ortho/types` already includes the optional fields, what should this contract test actually assert to meaningfully block a broken deploy?

    A. Use TypeBox to validate the incoming `lead.created` event payload shape at runtime — assert that `referrer_id`, `referrer_type`, and `referral_code` fields are **present** (even if nullable). The test publishes a synthetic event without these fields and asserts the validator rejects it.
    B. Write a TypeScript compile-time check (`satisfies`) that ensures the `LeadCreatedPayload` type includes all three fields — this fails at `typecheck` time if the types are wrong.
    C. Both A and B: TypeBox schema validation in the handler + a TypeScript compile-time assertion in the contract test file.

    **Answer:** a

---

### Environment and Configuration

11. The spec mentions two distinct URL env vars for the Referral Service link flow:
    - `DEFAULT_REFERRAL_LANDING_URL` — the practice landing page (used as `redirect_url` on new link creation)
    - `REFERRAL_BASE_URL` — CRM API Gateway public base URL (used to construct `referral_link_url` in `referrer.created` payload, e.g. `https://api.yourpractice.com`)

    Should any additional env vars be confirmed or renamed for implementation? Specifically, what is the correct name for the internal Lead Service API key passed in service-to-service calls?

    A. `LEAD_SERVICE_API_KEY` — the key injected as a header (e.g. `x-api-key`) when calling `GET /leads/:id`. Also confirm: `LEAD_SERVICE_URL`, `MESSAGING_SERVICE_URL`, `IDENTITY_JWKS_URL`.
    B. `INTERNAL_API_KEY` — a single shared internal key used across all service-to-service calls in the monorepo.
    C. No API key for internal calls — service-to-service traffic is authorized via network-level controls (VPC security groups); calls include a service identity header only.
 
    **Answer:** a

12. The spec says the Referral Service has no Redis and no BullMQ queues (confirmed if Answer 1 = A). Should the service's `env.ts` still include `REDIS_URL` / `BULLMQ_REDIS_URL` env vars (for future use or local docker-compose consistency), or should it omit them entirely since they are not needed at launch?

    A. Omit — YAGNI. No Redis, no BullMQ, no env vars for them. Keeps the env surface minimal.
    B. Include `REDIS_URL` for the `@ortho/event-bus` RedisStreamsDriver (used in local dev/integration tests via `EVENT_BUS_DRIVER=redis`). No `BULLMQ_REDIS_URL` needed since there's no BullMQ worker.

    **Answer:** a

---

### Service Structure

13. The spec describes `workers/event-worker.ts` and `workers/handlers/` as a separate workers entrypoint. Looking at the Lead Service, the event worker is bootstrapped from the main `index.ts`. Should the Referral Service have a **separate worker entrypoint** (distinct from the API server, requiring two processes) or integrate the event worker startup into `index.ts` (single process)?

    A. Single `index.ts` entry point — starts both the Fastify HTTP server and the event bus worker in the same process. Same pattern as the Lead Service (`index.ts` starts the app and calls `createEventWorker(...).start()`).
    B. Two separate entry points: `index.ts` for the HTTP server, `worker.ts` for the event consumer — separate ECS tasks, independent scaling.

    **Answer:** b

14. The spec lists `notification.service.ts` as a service layer file responsible for building the SMS message body and calling Messaging Service. What should the SMS message body say for each notification type? The spec mentions "includes referrer first name" but does not define the exact strings.

    A. Define the exact strings in the spec answers here (for both `exam_scheduled` and `converted` notifications) so the implementation can hardcode them.
    B. Hardcode reasonable defaults in `notification.service.ts` (e.g. "Hi {firstName}, great news — the patient you referred has scheduled their exam!" and "Hi {firstName}, the patient you referred has started treatment!") and mark them as `// TODO: confirm copy with product` comments.
    C. Pull SMS templates from Template Service (like Campaign Service does) — use a dedicated template for each notification type.

    **Answer:** b
