# Clarifying Questions: Data Import Service

> Original request: Build the Data Import Service (`apps/crm/import`) — a product-layer service that bridges Ortho2 (the practice EHR) and the CRM via manual CSV export/import. Handles CSV upload, column auto-mapping, 5-tier lead matching, validation preview, async job processing (parse → execute → undo), import log, and 2-hour bulk undo. Spec: `docs/superpowers/specs/2026-03-25-data-import-service-design.md`.

## Questions

---

### Service Skeleton & Startup

1. What is the entry point structure for `src/index.ts`?
   A. Minimal: create Fastify app, register `authPlugin`, register routes, listen on `PORT`
   B. Same as above plus `createLogger('import')`, BullMQ worker startup, and graceful shutdown (`SIGTERM` → drain worker → `bus.stop()`)
   C. Defer worker startup to a separate process (`src/worker.ts`) so the HTTP server and worker run as independent ECS tasks

   **Answer:** B — single process. The spec defines one service with routes + workers in the same layout. ECS runs one task definition for the service; the worker and Fastify share the process. Graceful shutdown drains the BullMQ worker before exiting. `src/index.ts` wires everything: `createLogger('import')`, Fastify with `authPlugin`, all route plugins registered, BullMQ worker started, `SIGTERM` handler.

2. Which environment variables does the service require?
   A. Only `DATABASE_URL`, `REDIS_URL`, `AWS_REGION`, `S3_BUCKET`, `PIPELINE_ENGINE_URL`, `LEAD_SERVICE_URL`, `IMPORT_SERVICE_API_KEY`, `IDENTITY_JWKS_URL`, `PORT`
   B. A superset including `LOG_LEVEL` (optional, default `info`) and `NODE_ENV`
   C. All of the above plus `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (or IAM role for ECS, so omitted from the explicit list)

   **Answer:** C. In ECS the AWS SDK picks up credentials from the task role automatically — no explicit key variables needed in the task definition. The required explicit set: `DATABASE_URL`, `REDIS_URL`, `AWS_REGION`, `S3_BUCKET`, `PIPELINE_ENGINE_URL`, `LEAD_SERVICE_URL`, `IMPORT_SERVICE_API_KEY`, `IDENTITY_JWKS_URL`, `PORT`, `LOG_LEVEL` (optional). `NODE_ENV` is set by the Docker image or ECS environment.

---

### Auth & RBAC

3. Which roles may call the import endpoints, and how is location scoping enforced?
   A. `call_center_manager` (own location only) and `marketing_manager+` (all locations); `requireLocation()` from `@ortho/auth-middleware` guards every endpoint
   B. Same roles but location scoping is handled manually in each route handler without `requireLocation()`
   C. Any authenticated user; location is implicitly scoped by the JWT's `locations` claim

   **Answer:** A. Per spec §5: `call_center_manager` (own location) and `marketing_manager+` (all locations). Use `requirePermission` + `requireLocation()` preHandlers from `@ortho/auth-middleware`. The CRM API Gateway enforces location scoping before forwarding, but the service double-checks per the auth-middleware ADR pattern.

4. How is the service-to-service API key (`IMPORT_SERVICE_API_KEY`) validated when calling Pipeline Engine and Lead Service?
   A. Passed as `Authorization: Bearer <key>` header in HTTP client requests; those services validate it via `POST /identity/api-keys/validate` on the Identity Service
   B. Passed as `X-Service-Key` custom header
   C. Embedded in the URL as a query param

   **Answer:** A. Per arch doc §3.2 the established pattern (same as `ANALYTICS_API_KEY` used by Reporting Service) is `Authorization: Bearer <key>`. Pipeline Engine and Lead Service validate `ak_`-prefixed service keys via the Identity Service. The HTTP clients in `src/clients/` always set this header.

---

### File Upload & S3

5. How is the CSV streamed to S3 during `POST /imports`?
   A. Multipart form parse (via `@fastify/multipart`), pipe the file stream directly to S3 `PutObject` using the AWS SDK v3 `Upload` helper (streaming, no temp file on disk)
   B. Buffer the entire file in memory, then write to S3 in one call
   C. Save to a temp file on the ECS container filesystem, upload to S3, then delete the temp file

   **Answer:** A. Stream directly to S3 using AWS SDK v3 `@aws-sdk/lib-storage` `Upload` helper. This avoids buffering large CSVs in memory and does not require disk I/O. The `@fastify/multipart` plugin provides the readable stream. S3 key: `imports/{import_id}/raw.csv`. The `import_id` is generated with `crypto.randomUUID()` before the upload begins so the key is known upfront.

6. What is the S3 bucket configuration assumption?
   A. The bucket is dedicated to the import service with its own lifecycle policy
   B. Same shared S3 bucket used by the Media Service, but under a separate prefix (`imports/` vs `media/`)
   C. A dedicated imports bucket, separate from the Media Service bucket (spec §2 explicitly states "direct S3 access, not via Media Service")

   **Answer:** C. Spec §2 is explicit: direct S3 access, not via Media Service. The bucket is configured separately. The `S3_BUCKET` env var points to this dedicated bucket (or a shared infra bucket with IAM path-scoped permissions — implementation detail for infra). The service writes to `imports/{import_id}/raw.csv` and reads from the same key during `parse_match`.

---

### BullMQ Worker

7. How are the three phases (`parse_match`, `execute`, `undo`) dispatched and differentiated?
   A. Single BullMQ queue (`import-jobs`), single job type, payload `{ import_id, phase }` where `phase` is `'parse_match' | 'execute' | 'undo'`; the worker switches on `phase`
   B. Three separate BullMQ queues, one per phase
   C. BullMQ flow (parent/child job dependencies)

   **Answer:** A. Per spec §6: single job type `import-job`, payload `{ import_id, phase }`. The worker in `src/workers/import-job.ts` switches on `phase`. This keeps the state machine simple — no separate queue management. Queue name: `import-jobs`.

8. What are the BullMQ job configuration settings?
   A. `attempts: 1` (no auto-retry — per spec, partial pipeline state makes blind retry dangerous); `removeOnComplete: true`; `removeOnFail: false` (keep failed jobs for Datadog visibility); concurrency: 2 per ECS instance
   B. `attempts: 3` with exponential backoff
   C. `attempts: 1`, `removeOnComplete: false`, `removeOnFail: false`

   **Answer:** A. Per spec §6: `attempts: 1`. Concurrency: 2 workers. `removeOnComplete: true` is appropriate — the import state is tracked in Postgres, not in BullMQ. `removeOnFail: false` allows inspection of failed job payloads in Datadog/BullMQ dashboard. The worker logs failures to Datadog and sets `imports.status = 'failed'`.

9. How does the worker handle a BullMQ job-level failure (uncaught exception in the worker handler)?
   A. Catch all errors in the worker, set `imports.status = 'failed'` with `error_message`, then re-throw so BullMQ marks the job failed (since `attempts: 1`, no retry occurs)
   B. Catch all errors, set import status to failed, swallow the error (job marked complete in BullMQ)
   C. Let the error propagate uncaught; BullMQ marks the job failed; a separate reconciliation job detects orphaned `parsing`/`executing` imports

   **Answer:** A. The worker wraps the entire phase handler in try/catch. On catch: update `imports.status = 'failed'`, `error_message = err.message`, then re-throw. BullMQ marks the job as failed. Since `attempts: 1`, no retry. Datadog APM picks up the uncaught error from BullMQ's `failed` event listener (wired at startup).

---

### Parse & Match Phase

10. How is the CSV parsed in Phase 1?
    A. Use the `csv-parse` npm package (streaming mode) to parse all rows into an array of `Record<string, string>` objects, then process
    B. Manual split on newlines and commas
    C. Use `papaparse` in Node.js mode

    **Answer:** A. `csv-parse` is the standard choice for Node.js CSV parsing — streaming-compatible, handles quoted fields, BOM, and CRLF. Read the S3 object as a readable stream, pipe through `csv-parse` with `columns: true` (uses first row as header keys) and `skip_empty_lines: true`.

11. How does auto-detection interact with the saved global column mapping during parse?
    A. Auto-detect using `ortho2-headers.ts` first → overlay the saved `column_mappings` entry for the import type on top (saved mapping overrides matching keys) → present final merged mapping in preview
    B. Saved mapping is used exclusively; auto-detection only runs if no saved mapping exists
    C. Auto-detection runs first; the coordinator must always manually confirm the final mapping

    **Answer:** A. Per spec §9: auto-detection runs first; saved mapping overrides matching entries; remaining unmapped headers surface in the mapping UI. The `parse_match` phase produces `detected_headers` (the raw CSV header row) and applies the merged mapping for matching. The confirmed mapping is saved at `POST /imports/:id/confirm` time.

12. How are Tiers 1–2 (phone/email) lookups implemented — individual API calls or batch prefetch?
    A. Batch prefetch: extract all phones and emails from all CSV rows upfront, call `GET /leads?phones[]={...}&location_id={id}` and `GET /leads?emails[]={...}&location_id={id}` once each, build in-process `Map<phone, Lead[]>` and `Map<email, Lead[]>` for O(1) per-row resolution
    B. Individual Lead Service call per row per tier
    C. Database query directly against `crm_leads` schema (violates golden rule — not used)

    **Answer:** A. Per spec §6 Phase 1, step 4: batch prefetch. This is critical for performance on large CSVs (e.g., 1000+ rows). The Map values are arrays to correctly capture the multi-match ambiguous case. Phone normalization to E.164 happens before the Map lookup.

13. What phone normalization library is used for E.164 conversion?
    A. `libphonenumber-js` (well-tested, supports US numbers without country code prefix)
    B. Manual regex strip of non-digits + prepend `+1`
    C. No normalization — assume the CSV already contains E.164

    **Answer:** A. `libphonenumber-js` is the standard choice. Ortho2 exports US numbers in various formats (`(555) 123-4567`, `555-123-4567`, `5551234567`). The library handles all formats and correctly produces E.164 (`+15551234567`). Applied consistently to both the CSV data and before Map lookups.

14. How are Tiers 3 and 4 name lookups handled for performance?
    A. `GET /leads?q={first} {last}&location_id={id}` → filter in-process; cache the result in-process for Tier 4 reuse within the same row only (not shared across rows)
    B. Separate API call for each of Tier 3 and Tier 4
    C. Only run if Tiers 1–2 don't find a batch-prefetched phone/email result

    **Answer:** A. Per spec §7 Tiers 3–4: one `GET /leads?q=...` call per row (only when Tiers 1–2 don't match); the result is cached in-process for Tier 4 reuse on the same row. This avoids a second API call for the name search. The cache is scoped to the current row's resolution — it is not shared across rows.

---

### Execute Phase

15. What does "sequential execution in `row_number ASC` order" mean for implementation?
    A. Use a `for` loop (not `Promise.all`) over the matched rows; `await` each row's Pipeline Engine calls before moving to the next
    B. Dispatch all rows as parallel BullMQ child jobs
    C. Process rows in batches of 10 with `Promise.all` per batch

    **Answer:** A. Per spec §6 Phase 2 and §13 (Sequential execution rationale): simple `for` loop, `await` each row. This ensures predictable undo ordering and avoids Pipeline Engine contention on the same lead if the CSV has duplicate leads. Performance is acceptable — imports are batch operations, not real-time.

16. What is the crash-recovery logic for rows stuck in `executing` status?
    A. On job restart, query `import_rows WHERE import_id = $1 AND status NOT IN ('executed', 'failed')` and skip rows with `status = 'executing'`; log each skipped row to Datadog
    B. Re-execute rows stuck in `executing` (risky — could double-apply transitions)
    C. Mark stuck `executing` rows as `failed` and continue

    **Answer:** A. Per spec §6 Phase 2 (Crash recovery): skip `executed` and `failed` rows on restart. Rows stuck in `executing` (crashed between `before_snapshot` write and Pipeline Engine call completion) are logged to Datadog and skipped — not re-executed, because the Pipeline Engine call may have partially succeeded. The coordinator handles these manually per the spec.

17. How is `before_snapshot` written atomically before the Pipeline Engine call?
    A. Single `UPDATE import_rows SET before_snapshot = $1, status = 'executing' WHERE id = $2` — both fields in one statement before any external call
    B. Write `before_snapshot` first, then update `status = 'executing'` in a second statement
    C. Write `before_snapshot` after the Pipeline Engine call succeeds

    **Answer:** A. Per spec §6 Phase 2 step 3: atomic DB update of both `before_snapshot` and `status = 'executing'` before any Pipeline Engine calls. This is the durability invariant: if the process crashes after the DB write but before the Pipeline Engine call, the undo phase can detect the `executing` status and skip the row.

---

### Undo Phase

18. How does the atomic undo initiation work in `POST /imports/:id/undo`?
    A. `UPDATE imports SET status = 'undoing' WHERE id = $1 AND status = 'completed' AND undo_deadline > now()` — check `rowCount`; if 0 rows updated, do a follow-up `SELECT status, undo_deadline` to discriminate 422 vs 409 vs 404
    B. `SELECT ... FOR UPDATE` then conditional `UPDATE` in a transaction
    C. Check status first in a `SELECT`, then `UPDATE` separately

    **Answer:** A. Per spec §5 (undo endpoint): single `UPDATE` with both conditions in the `WHERE` clause. If `rowCount === 0`, do a follow-up read to determine why. This avoids TOCTOU races between two simultaneous undo requests. The follow-up `SELECT` reads `status` and `undo_deadline` to produce the correct error code.

19. For conversion undo (`active_patients`, `completed_patients`), what is the correct operation order?
    A. 1) `POST /pipeline/memberships/:post_import_membership_id/close` → 2) `POST /pipeline/memberships` (re-enroll at `pre_import_pipeline` + `pre_import_stage`)
    B. 1) Re-enroll first, 2) close the post-import membership
    C. Single call to a `/pipeline/memberships/:id/revert` endpoint

    **Answer:** A. Per spec §8: close the post-import membership first (so the `UNIQUE (lead_id, pipeline) WHERE status = 'active'` constraint is satisfied), then re-enroll. `location_id` for re-enrollment comes from `imports.location_id`, not from the snapshot. The close call uses `status = 'closed'` (not `'archived'`) and `closed_reason = 'import_undo'` — this is a pending amendment to the Pipeline Engine spec.

20. What happens if a row's undo operation fails (e.g., Pipeline Engine returns 4xx/5xx)?
    A. Log the error to Datadog, write `error_message` to the row, set row `status` back to `'executed'` (it never changed during undo attempt), continue to the next row — best-effort undo
    B. Abort the entire undo job and set `imports.status = 'failed'`
    C. Retry the failed row 3 times before continuing

    **Answer:** A. Per spec §6 Phase 3: best-effort undo. On failure: log to Datadog, record `error_message` on the row, continue. The row remains `'executed'` (the undo service should not update `status` unless the undo succeeds). After all rows are processed, `imports.status = 'undone'` is set regardless of partial failures — the import log shows which rows failed.

---

### Column Mapping

21. When `POST /imports/:id/confirm` is called, what happens to the column mapping?
    A. Upsert `column_mappings` table (one row per import type, `ON CONFLICT (import_type) DO UPDATE`), then snapshot the confirmed mapping into `imports.column_mapping`, then enqueue `execute` phase job
    B. Only save to `imports.column_mapping`; the global `column_mappings` table is updated separately
    C. Only enqueue the execute job; mapping persistence is fire-and-forget in a background task

    **Answer:** A. Per spec §9: `POST /imports/:id/confirm` does three things atomically from the user's perspective: (1) upsert global `column_mappings`, (2) save confirmed mapping as `imports.column_mapping` snapshot, (3) enqueue `execute` job. The route validates `imports.status = 'preview_ready'` before proceeding; returns `409` if wrong status. Returns `202 Accepted` — the execute job runs asynchronously.

22. Does `POST /imports/:id/confirm` re-run match logic with the new mapping?
    A. No — per spec §9 it executes the existing matched rows as-is; if the coordinator corrected a critical column mapping, they must cancel + re-upload
    B. Yes — re-runs match logic against the new mapping before executing
    C. Partial — only re-runs Tier 1 (phone) if the phone column mapping changed

    **Answer:** A. Per spec §9 (explicit callout): `POST /imports/:id/confirm` does NOT re-run match logic. The coordinator is expected to review the match preview before confirming. If a mapping correction would materially affect matches, the correct flow is `POST /imports/:id/cancel` + re-upload.

---

### Route Structure & Validation

23. How is route registration ordering handled to avoid Fastify matching `"column-mappings"` as `:id`?
    A. Register `GET /imports/column-mappings/:type` in `src/routes/mappings.ts` and register it **before** the `GET /imports/:id` route in `src/routes/imports.ts`; both are registered as separate Fastify plugins in `src/index.ts` with mappings first
    B. Use a regex constraint on `:id` to only match UUIDs: `{ schema: { params: { id: { type: 'string', format: 'uuid' } } } }`
    C. Use a single route file and rely on Fastify's static-vs-parameterized route priority

    **Answer:** A and B — belt-and-suspenders. Per spec §5: register `mappings.ts` before `imports.ts` in `src/index.ts`. Additionally, constrain `:id` with a UUID format check via TypeBox schema in the route options. Both protections together make the routing unambiguous and provide a clear 400 error for malformed IDs.

24. How are request bodies validated?
    A. TypeBox schemas (`@sinclair/typebox`) defined per route, passed to Fastify's `schema: { body: T }` option for compile-time-validated JSON Schema
    B. Manual validation in route handlers with early-return pattern
    C. Zod schemas

    **Answer:** A. Per CLAUDE.md stack: `@sinclair/typebox 0.34` is the project standard for schema validation. Define TypeBox schemas in each route file or a `src/schemas/` directory. Pass to Fastify `schema` option. Fastify compiles to AJV validators at startup — fast runtime validation with TypeScript inference.

---

### Database & Repositories

25. How is DB access structured following the monorepo pattern?
    A. `@ortho/db` package provides the Knex instance; each repository (`import.repo.ts`, `import-row.repo.ts`, `column-mapping.repo.ts`) takes the Knex instance via constructor injection
    B. Each repository creates its own Knex connection
    C. Raw `pg` driver queries in route handlers

    **Answer:** A. Per CLAUDE.md: `@ortho/db` provides the Knex 3 setup and connection pool. Repositories use constructor injection. The Knex instance is created once at startup in `src/index.ts` and passed to services/repositories. Schema: `crm_imports` — all table names are unqualified (Knex is configured with `searchPath: 'crm_imports'`).

26. How are migrations managed?
    A. Knex migrations in `migrations/` directory; run as a pre-deploy step by the deployment pipeline; the service only migrates its own `crm_imports` schema
    B. Run migrations at application startup via `@ortho/db` migration runner
    C. Manual SQL applied to the DB by the DBA

    **Answer:** A. Per CLAUDE.md architecture and `@ortho/db` ADR: migrations live in `migrations/` and are run as a pre-deploy step. This is standard for all services in the monorepo. The `@ortho/db` package provides a `runMigrations(knex)` utility that the deploy script calls before starting the ECS task.

---

### HTTP Clients

27. What library is used for HTTP calls to Pipeline Engine and Lead Service?
    A. Node.js built-in `fetch` (Node 24 has `fetch` globally available), wrapped in typed client classes in `src/clients/`
    B. `axios`
    C. `undici`

    **Answer:** A. Node.js 24 includes `fetch` natively. The clients in `src/clients/pipeline-engine.ts` and `src/clients/lead-service.ts` are thin typed wrappers around `fetch`. They read base URLs from env vars, attach the `Authorization: Bearer <IMPORT_SERVICE_API_KEY>` header, and throw typed errors on non-2xx responses. No extra HTTP library dependency needed.

28. How are HTTP client errors handled — e.g., Pipeline Engine returning 5xx?
    A. Typed error class (e.g., `PipelineEngineError`) thrown from the client; the worker catches it, marks the row `failed` with `error_message = 'pipeline_engine_error: <status>'`, continues to next row
    B. Retry up to 3 times with exponential backoff before marking row failed
    C. Propagate the error up to the BullMQ job handler, failing the entire job

    **Answer:** A. Per spec §6 Phase 2 step 6: on per-row failure, set row `status = 'failed'`, `error_message`, continue. The `attempts: 1` job-level config applies to uncaught job-level errors — per-row errors are caught and handled in the loop. No retry per row (spec rationale: partial state makes retry dangerous). For transient 5xx, the coordinator can re-run by re-uploading.

---

### Testing

29. How are Pipeline Engine and Lead Service mocked in integration tests?
    A. HTTP interceptors (e.g., `nock` or `msw` in Node mode) that intercept `fetch` calls to the service base URLs; configured per test to return expected responses
    B. Actual running services in Docker Compose
    C. Jest/Vitest `vi.mock()` module mocks of the client classes

    **Answer:** A. Per spec §12: "Pipeline Engine and Lead Service mocked via HTTP interceptors." Use `nock` (or `msw` Node adapter) to intercept outbound `fetch` calls. This allows testing the full worker flow against a real Postgres instance without needing Pipeline Engine running. Integration tests run with `vitest` + real Postgres (per `@ortho/testing` package conventions).

30. What does the contract test for `before_snapshot` written-before-calls verify?
    A. The HTTP interceptor for Pipeline Engine calls tracks call order; the test asserts that the DB row has `before_snapshot` populated and `status = 'executing'` before any interceptor records a Pipeline Engine call — verified by using an interceptor that captures the DB state on first call
    B. A separate unit test for `import-job.ts` that mocks the DB write and Pipeline Engine call in sequence
    C. Manual inspection of log output

    **Answer:** A. The integration test wires a Pipeline Engine interceptor whose response handler reads the `import_rows` DB state synchronously before returning the mock response. The assertion: `before_snapshot IS NOT NULL` and `status = 'executing'` at the moment Pipeline Engine is first called. This directly verifies the durability invariant from spec §13.

---

### Logging & Observability

31. How is structured logging applied throughout the service?
    A. `createLogger('import')` from `@ortho/logger` at module level; child loggers via `log.child({ importId, phase })` in the worker for per-job context; `log.child({ requestId, locationId })` in route handlers
    B. `console.log` statements
    C. Datadog agent picks up stdout automatically; no structured logging needed

    **Answer:** A. Per `adr-logger.md`: `createLogger('import')` creates the service-level Pino logger. The worker creates a child logger per job with `{ importId, phase }`. Route handlers create child loggers with `{ requestId, locationId }`. All errors are logged with `log.error({ err }, 'message')` — passing the error object under `err` key so Pino serializes stack traces.

---

### Pagination & Preview

32. How is cursor-based pagination implemented for `GET /imports/:id/rows`?
    A. Cursor is `import_row.id` (UUID); query uses `WHERE import_id = $1 AND id > $cursor ORDER BY id ASC LIMIT $limit`; response includes `{ data: rows[], nextCursor: string | null }`
    B. Offset-based pagination (`page`, `pageSize`)
    C. Cursor is `row_number`; query uses `WHERE import_id = $1 AND row_number > $cursor`

    **Answer:** C. Using `row_number` as the cursor is more natural here — rows have a stable, sequential `row_number` that maps to the original CSV row order. Query: `WHERE import_id = $1 AND ($cursor IS NULL OR row_number > $cursor) AND ($status IS NULL OR status = $status) ORDER BY row_number ASC LIMIT $limit`. Response: `{ data: rows[], nextCursor: lastRowNumber | null }`. `nextCursor` is `null` when the returned count < `limit`.

---

## Additional Context

- Service layout exactly as specified in spec §11: `src/routes/`, `src/services/`, `src/workers/`, `src/clients/`, `src/mapping/`, `src/repositories/`
- No EventBridge events published or subscribed — REST-only inbound (via CRM API Gateway) and REST-only outbound (to Pipeline Engine + Lead Service)
- The `triggered_by` value on all Pipeline Engine calls is `req.user.sub` from the decoded JWT forwarded by the CRM API Gateway
- Import types are a closed enum — hardcoded in TypeBox schemas and DB CHECK constraints; no dynamic extension
- The `IMPORT_SERVICE_API_KEY` is an `ak_`-prefixed service key created in the Identity Service and stored in ECS secrets; the same pattern as `ANALYTICS_API_KEY` used by the Reporting Service
- `imports.column_mapping` stores the coordinator's **confirmed** mapping (submitted at confirm time), not the auto-detected mapping used during parse — these may differ if the coordinator adjusted mappings in the preview UI
- Rows with `status = 'ambiguous'` or `'unmatched'` are visible in the preview but never executed — the coordinator sees them in `GET /imports/:id/rows?status=unmatched` and `?status=ambiguous`
- The `undo_deadline` is set to `completed_at + interval '2 hours'` in the SQL UPDATE that marks the import `completed` — computed in Postgres, not in Node.js
