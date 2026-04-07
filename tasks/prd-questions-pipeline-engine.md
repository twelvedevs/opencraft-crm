# Clarifying Questions: Pipeline Engine

> Original request: Implement the Pipeline Engine service as specified in `docs/superpowers/specs/2026-03-25-pipeline-engine-design.md` — a product-layer state machine managing 3 pipelines / 13 stages, stage transition validation, timeout enforcement via node-cron, and EventBridge event publishing.

---

## Questions

### Package & Runtime

1. What port should the Pipeline Engine listen on?
   A. 3004 (continuing Lead Service's port + 1)
   B. 3005
   C. Driven by `PORT` env var with no hardcoded default
   D. Other: [please specify]

   **Answer:** C, default to 3005

2. What is the npm package name for this service?
   A. `@ortho/pipeline-engine`
   B. `@crm/pipeline`
   C. `pipeline-engine` (unscoped)
   D. Other: [please specify]

   **Answer:** A

3. What `DATABASE_URL` env var convention should the service use?
   A. `DATABASE_URL` (plain)
   B. `PIPELINE_DATABASE_URL` (service-prefixed)
   C. Matches whatever `@ortho/db` expects
   D. Other: [please specify]

   **Answer:** A

---

### Database & Migrations

4. How should the Knex pool be configured to use the `crm_pipeline` schema?
   A. Set `searchPath: 'crm_pipeline'` in the Knex pool config so queries use unqualified table names (`pipeline_memberships`)
   B. Prefix every table reference with the schema (`crm_pipeline.pipeline_memberships`)
   C. Use whatever pattern `@ortho/db` establishes for schema isolation
   D. Other: [please specify]

   **Answer:** A

5. Should the service use the shared `@ortho/db` package for Knex setup and migration runner, or configure Knex directly?
   A. Use `@ortho/db` — import the shared Knex factory and migration runner
   B. Configure Knex directly in the service — `@ortho/db` is only for shared utilities
   C. Other: [please specify]

   **Answer:** B

6. What migration file naming convention should be used?
   A. Timestamp prefix: `20260325000000_create_pipeline_memberships.ts`
   B. Sequential: `001_create_pipeline_memberships.ts`
   C. Whatever Knex CLI generates by default
   D. Other: [please specify]

   **Answer:** A

---

### Auth & Middleware

7. Does the Pipeline Engine need `@ortho/auth-middleware` at all, given the CRM API Gateway is the sole caller and handles all RBAC?
   A. No auth middleware — the service is internal-only; the CRM Gateway authenticates callers via a shared API key or network policy
   B. Minimal API key check — the Gateway includes a static shared secret in a header; Pipeline Engine validates it
   C. Use `@ortho/auth-middleware` in pass-through mode (just extract `triggered_by` from JWT without re-validating permissions)
   D. Other: [please specify]

   **Answer:** B

---

### Event Bus Integration

8. Since Pipeline Engine is publish-only (no subscriptions), how should `@ortho/event-bus` be used at startup?
   A. Call `bus.publish()` directly; never call `bus.subscribe()` or `bus.start()` — publish-only services skip `start()` per the ADR
   B. Still call `bus.start()` for consistency, even though it logs a warning and returns without connecting
   C. Other: [please specify]

   **Answer:** B

9. Should `bus.stop()` be called during graceful shutdown even if `bus.start()` was never called?
   A. Yes — always call `stop()` in SIGTERM handler for safety
   B. No — only call `stop()` if `start()` was called
   C. Other: [please specify]

   **Answer:** A

10. The spec's event envelopes show a top-level `event_id` field, but `OrthoEvent` in the event-bus ADR has no `event_id` — only `correlation_id`. Where should `event_id` live?
    A. In the `payload` object (keep `OrthoEvent` envelope unchanged)
    B. Add `event_id` to the `OrthoEvent` envelope — the ADR example is just incomplete
    C. Use `correlation_id` as the `event_id` — they serve the same purpose
    D. Other: [please specify]

    **Answer:**  B

11. How should `correlation_id` be populated on published events?
    A. Generate a fresh `randomUUID()` per event at publish time
    B. Forward the `X-Correlation-Id` (or equivalent) request header from the inbound HTTP call so the trace spans services
    C. Leave `correlation_id` undefined — Pipeline Engine is a leaf publisher with no upstream chain to carry
    D. Other: [please specify]

    **Answer:** B

12. Should all published events include `schema_version: '1.0'`?
    A. Yes — always set `schema_version: '1.0'` for all four event types
    B. No — omit `schema_version` until a versioning story is established
    C. Other: [please specify]

    **Answer:** A

---

### Integration Tests

13. The spec says "EventBridge publish mocked via HTTP interceptor." Given the `@ortho/event-bus` ADR provides `MockDriver` specifically for publish-only services, which approach should integration tests use?
    A. Inject `MockDriver` via `createEventBus({ driver })` — assert on `driver.published[]`; no HTTP interceptor needed
    B. Use `nock` or `msw` to intercept the AWS SDK's HTTP calls — test that the raw HTTP payload matches the expected shape
    C. Use `RedisStreamsDriver` with a local Redis, then consume from the stream to assert event contents
    D. Other: [please specify]

    **Answer:** A

14. How should the integration test database be set up and torn down?
    A. Use `@ortho/testing` fixtures — the package provides a shared test DB setup/teardown helper
    B. Each test file spins up its own schema via Knex migrations in `beforeAll` and drops it in `afterAll`
    C. Tests run against a fixed local Postgres DB seeded by `docker-compose`; truncate tables between tests
    D. Other: [please specify]

    **Answer:** B

15. For the `SKIP LOCKED` concurrent-run test, how should two concurrent DB connections be simulated in Vitest?
    A. Two separate Knex pool instances in the same test — transaction A holds the lock, transaction B runs the poller and asserts it skips the locked row
    B. Spawn two `Worker` threads each with their own DB connection
    C. Use `pg` directly (not Knex) to hold the lock in one connection while running the poller in another
    D. Other: [please specify]

    **Answer:** C

16. Should contract tests (event payload shape assertions) live in the same integration test files or in a dedicated `test/contract/` folder?
    A. Dedicated `test/contract/` folder — kept separate from integration tests for clarity
    B. Co-located in integration test files — assert payload shape at the point each event is published
    C. Other: [please specify]

    **Answer:** A

---

### Request Validation & Error Handling

17. Should TypeBox be used for all request body and response schemas, or only for the route definitions?
    A. Full TypeBox schemas for all request/response shapes — use `@sinclair/typebox` + Fastify's built-in schema validation
    B. TypeBox for request validation only; responses are typed by TypeScript but not schema-validated
    C. Other: [please specify]

    **Answer:** A

18. For unexpected server-side failures (DB connection error, unhandled exception), what HTTP response should be returned?
    A. `500 { "error": "internal_error" }` — consistent with the spec's error shape
    B. `500 { "error": "internal_server_error" }` — more descriptive string
    C. Let Fastify's default error handler return its standard JSON shape
    D. Other: [please specify]

    **Answer:** A

---

### Timeout Polling Job

19. What `node-cron` npm package should be used?
    A. `node-cron` (the standard package — `npm install node-cron`)
    B. `cron` (alternative, `npm install cron`)
    C. `croner` (modern alternative with better TypeScript support)
    D. Other: [please specify]

    **Answer:** C

20. How should the timeout poll job be stopped during graceful shutdown (SIGTERM)?
    A. Set the in-process `isRunning` flag and let the current batch complete; stop the cron schedule with `task.stop()`
    B. Use `task.stop()` immediately — the DB transaction will roll back cleanly on process exit
    C. Wait for the current batch to finish (up to a configurable timeout), then stop
    D. Other: [please specify]

    **Answer:** A

21. Should the timeout poll job be enabled/disabled via an env var (e.g. `TIMEOUT_POLL_ENABLED=false`) to make testing easier?
    A. Yes — always check env var before starting the cron schedule so integration tests can disable it
    B. No — tests control the job by calling the poll function directly; the cron scheduler is not started in tests
    C. Other: [please specify]

    **Answer:** A

---

### `SELECT … FOR UPDATE` in Knex

22. How should `SELECT … FOR UPDATE SKIP LOCKED` be expressed with Knex 3?
    A. Use `.forUpdate().skipLocked()` — Knex 3 supports these as query builder modifiers
    B. Use `knex.raw('SELECT … FOR UPDATE SKIP LOCKED')` — raw SQL is simpler and safer
    C. Wrap the lock in a stored procedure
    D. Other: [please specify]

    **Answer:** B

---

### Route Structure

23. How should the Fastify route prefix be structured?
    A. Register all routes under a `/pipeline` Fastify plugin prefix, with sub-routes like `/memberships`, `/memberships/:id/transition`, etc. — the service's full path is `/pipeline/memberships`
    B. No prefix in the service itself — the CRM API Gateway handles the `/pipeline` prefix routing; service routes start at `/memberships`
    C. Other: [please specify]

    **Answer:** A

---

### Logging

24. What structured log fields should be bound on each request (child logger)?
    A. `{ requestId, leadId, membershipId, locationId }` — bind all available IDs as they become known during the request
    B. `{ requestId }` only at the route handler level; add `leadId`/`membershipId` only in service layer logs
    C. Follow the pattern in `adr-logger.md` exactly: bind `requestId` + `locationId` from request headers at handler entry
    D. Other: [please specify]

    **Answer:** A

25. What log level should the timeout poll job use for its per-run summary?
    A. `info` for the summary line (N leads processed) and `warn` for per-row failures
    B. `debug` for the summary line (polls are high-frequency); `error` for per-row failures
    C. `info` for normal processing; `error` for per-row failures; `warn` for runs that hit the 100-row batch cap
    D. Other: [please specify]

    **Answer:** C
