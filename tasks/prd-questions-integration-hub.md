# Clarifying Questions: Integration Hub

> Original request: Generate implementation PRD for the Integration Hub service as specified in `docs/superpowers/specs/2026-03-25-integration-hub-design.md`. Refer to `docs/arch/adr-event-bus.md` and `docs/arch/adr-logger.md` for package usage patterns.

## Questions

### OAuth & Credential Security

1. The spec says `GET /integrations/connect/:platform` builds an OAuth URL with "PKCE state," but PKCE requires a `code_verifier`/`code_challenge` pair that must survive the browser redirect round-trip. Where should this state be persisted between the initial redirect and the callback?
   A. Signed, short-lived cookie (e.g. 10-minute `__Host-oauth-state` cookie set by the service)
   B. Server-side Redis entry keyed by the `state` UUID (TTL 10 minutes)
   C. Encoded into the `state` parameter itself and verified on callback (stateless — no server-side storage)
   D. Other: [please specify]

   **Answer:** C

2. AES-256-GCM encryption requires a random IV for every encryption operation. How should the IV be stored alongside the ciphertext in the `access_token` / `refresh_token` columns?
   A. Prepend the IV to the ciphertext and store both as a single base64 string in the existing column (e.g. `base64(iv || ciphertext || authTag)`)
   B. Add a separate `access_token_iv` / `refresh_token_iv` column for each token field
   C. Store a JSON object `{ iv, ciphertext, tag }` serialised as base64 in the existing column
   D. Other: [please specify]

   **Answer:** C

3. `INTEGRATION_HUB_ENCRYPTION_KEY` is fetched from AWS Secrets Manager at startup. What format is the key value stored as in Secrets Manager?
   A. 32-byte random value encoded as a hex string (64 chars)
   B. 32-byte random value encoded as base64 (44 chars)
   C. Raw binary (Secrets Manager binary secret)
   D. Other: [please specify]

   **Answer:** B. Please also implement abstraction on top of AWS Secrets Manager so that we can continue developing it locally, and have no dependency on AWS Secrets Manager.

---

### JWT Validation

4. `@ortho/auth-middleware` is an empty stub. How should JWT validation be implemented for the protected endpoints in this service?
   A. Inline Fastify `preHandler` hook that verifies the JWT using the Identity Service public key (loaded from env var `IDENTITY_SERVICE_PUBLIC_KEY`)
   B. Inline Fastify `preHandler` that calls the Identity Service `/auth/verify` endpoint on each request
   C. Inline Fastify `preHandler` that verifies against a JWKS endpoint published by the Identity Service
   D. Other: [please specify]

   **Answer:** A + C (configurable)

---

### External API Clients (Google Ads & Meta)

5. Should the `GoogleAdsConnector` and `MetaConnector` call the platform APIs using native `fetch` (Node 24 built-in) or a dedicated SDK package?
   A. Native `fetch` only — no additional dependencies. HTTP calls constructed manually per the Google Ads REST API and Meta Graph API docs.
   B. Official Google Ads Node.js client (`google-ads-api` npm package) for Google; native `fetch` for Meta
   C. Both connectors use native `fetch`, but wrapped in a thin typed helper per connector
   D. Other: [please specify]

   **Answer:** B, and use thin typed helper as a wrapper

6. The spec says Google Ads spend data uses `GoogleAdsService.search` (GAQL). Which Google Ads API version should be targeted?
   A. v19 (latest stable as of March 2026)
   B. Whatever version is current at implementation time — document the version in a constant
   C. Other: [please specify]

   **Answer:** B

7. Meta Marketing API spend uses `/act_{account_id}/insights`. Which Meta Graph API version should be targeted?
   A. v22.0 (latest stable as of March 2026)
   B. Whatever version is current at implementation time — document the version in a constant
   C. Other: [please specify]

   **Answer:** B

---

### EventBus Usage

8. Integration Hub is a **publish-only** service — it publishes `ad_lead.received` and `ad_spend.synced` but never subscribes to any events. Per `adr-event-bus.md`, calling `bus.start()` with zero subscriptions logs a warning and is valid for publish-only services. What should the startup behaviour be?
   A. Call `createEventBus()` and `bus.publish()` directly from job handlers — never call `bus.start()` (skip the consumer loop entirely since there are no subscriptions)
   B. Call `bus.start()` anyway at service startup to remain consistent with other services (accept the warning log)
   C. Other: [please specify]

   **Answer:** A

---

### `@ortho/types` Event Payload Types

9. `ad_lead.received` and `ad_spend.synced` are new event types that need to be consumed by Lead Service and Analytics Service respectively. Should typed payload interfaces be added to `@ortho/types` as part of this implementation?
   A. Yes — add `AdLeadReceivedPayload`, `AdLeadReceivedEvent`, `AdSpendSyncedPayload`, `AdSpendSyncedEvent` to `packages/@ortho/types/src/events.ts`
   B. No — keep payload types local to `integration-hub/src/connectors/interface.ts`; consuming services define their own local types for the fields they care about
   C. Other: [please specify]

   **Answer:** A

---

### BullMQ & Job Lifecycle

10. BullMQ repeatable jobs (`poll-ad-spend`) persist in Redis across service restarts. What should the service do on startup regarding existing poll jobs?
    A. No action — rely on Redis persistence; only register a new repeatable job when a new account is connected
    B. On startup, load all `active` accounts from the DB and call `queue.upsertJobScheduler(...)` for each — this is idempotent and handles cases where the Redis state was lost
    C. On startup, remove all existing repeatable jobs and re-register from the DB — clean slate every restart
    D. Other: [please specify]

    **Answer:** B

11. The `refresh-token` job for Google Ads is a delayed one-off job identified by `refresh-token:{account_id}`. What BullMQ API should be used to cancel it when an account is disconnected?
    A. `queue.getJob('refresh-token:{account_id}')` then `job.remove()` — standard BullMQ job removal by ID
    B. Use a named job scheduler (`queue.upsertJobScheduler`) so it can be removed with `queue.removeJobScheduler(name)`
    C. Store the BullMQ job ID in the `integration_accounts` row and use it for targeted removal
    D. Other: [please specify]

    **Answer:** A

---

### Webhook Handling

12. When `parseLeadWebhook()` throws (malformed payload), the spec says: log at `warn` level and still return `200`. Should the raw body be persisted anywhere for manual re-processing, beyond the Pino `warn` log?
    A. No — the warn log (with raw body string) is sufficient; manual re-processing is out of scope
    B. Yes — write the raw body to a `failed_webhooks` DB table with timestamp and platform
    C. Yes — write the raw body to an S3 bucket under a `failed-webhooks/` prefix
    D. Other: [please specify]

    **Answer:** B

13. The spec lists `GET /integrations/webhooks/meta/verify` for Meta's subscription verification challenge. Should Google Ads webhook verification also have a challenge/verification endpoint, or does Google Ads not require one?
    A. Google Ads lead form webhooks do not have a subscription verification step — only Meta requires this
    B. Google Ads also requires a challenge endpoint — add `GET /integrations/webhooks/google_ads/verify`
    C. Other: [please specify]

    **Answer:** B

---

### Backfill

14. The `backfill-ad-spend` job iterates in 7-day chunks and the status endpoint returns `{ chunks_done, chunks_total }`. How should the job report progress?
    A. Use BullMQ's built-in `job.updateProgress({ chunks_done, chunks_total })` after each chunk; the status endpoint calls `queue.getJob(job_id)` and reads `job.progress`
    B. Write progress to a dedicated `backfill_jobs` DB table after each chunk; the status endpoint reads from DB
    C. Other: [please specify]

    **Answer:** B

---

### Observability & Alerts

15. The spec says "trigger Datadog alert" on `poll-ad-spend` and `refresh-token` failure. What is the intended alert mechanism?
    A. A Pino `error` log with structured fields (e.g. `{ account_id, platform, err }`) — Datadog log-based monitor picks it up; no additional instrumentation needed from the service
    B. Increment a Datadog custom metric (e.g. `integration_hub.poll.failure`) via `dogstatsd` in addition to logging
    C. Implementation detail — just log the error; alert configuration is handled separately in the Datadog setup
    D. Other: [please specify]

    **Answer:** A

---

### UI Package Scope

16. The spec defines `@platform/integration-hub-ui` with four React components. Is this UI package in scope for the current implementation pass alongside the backend service?
    A. No — backend service only (`apps/platform/integration-hub`); UI package is a separate deliverable
    B. Yes — both the backend service and the UI package (`packages/@platform/integration-hub-ui`) are in scope
    C. Other: [please specify]

    **Answer:** A

---

### Database & Migrations

17. The spec uses schema `platform_integrations`. What tool/pattern should be used for runtime DB queries (separate from Knex migrations)?
    A. Raw `pg` Pool + `PoolClient` directly (same pattern as analytics service on the current branch — Knex only for migrations)
    B. Knex query builder for both migrations and runtime queries
    C. Other: [please specify]

    **Answer:** A

---

### Testing

18. What test coverage is required for this implementation pass?
    A. Unit tests only — connector logic (`parseLeadWebhook`, `verifyWebhook`, `fetchSpend`), credential encrypt/decrypt, and job handler logic with mocked dependencies
    B. Unit tests + integration tests — at minimum: webhook route (with signature verification), OAuth callback flow, and a BullMQ job worker against a real Redis
    C. Unit tests for pure logic; integration tests are a separate story
    D. Other: [please specify]

    **Answer:** A
