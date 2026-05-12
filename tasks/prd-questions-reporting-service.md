# Clarifying Questions: Reporting Service

> Original request: Implement the Reporting Service per the approved design spec at `docs/superpowers/specs/2026-03-25-reporting-service-design.md`

## Questions

1. The spec says the Fastify HTTP server and BullMQ worker run in the same ECS task process. Should `index.ts` boot both together unconditionally, or should there be a way to start them independently (e.g. an env flag or a separate `worker.ts` entry point)?
   A. Single `index.ts` — always boots Fastify + BullMQ worker together in one process; no separate entry point
   B. `index.ts` boots both by default; `WORKER_ONLY=true` env var boots only the BullMQ worker (useful for independent scaling of report generation)
   C. Two entry points: `src/index.ts` (HTTP server) and `src/worker.ts` (BullMQ worker); deployed as two ECS tasks sharing the same Redis and DB
   D. Other: [please specify]

   **Answer:** A

2. What port should the Reporting Service listen on, and what are the required environment variables?
   A. Port `3009` (following service port convention); env vars: `DATABASE_URL`, `REDIS_URL`, `ANALYTICS_SERVICE_URL`, `ANALYTICS_API_KEY`, `MEDIA_SERVICE_URL`, `INTERNAL_API_SECRET`, `EMAIL_SERVICE_URL`, `NOTIFICATION_SERVICE_URL`, `CRM_BASE_URL`, `IDENTITY_JWKS_URL`, `PORT`, `LOG_LEVEL`
   B. Port `3009`; same as A plus `SERVICE_CALLER_ID` (sentinel UUID for Media Service uploads), `LRU_CACHE_MAX` (default 500), `LRU_CACHE_TTL_MS` (default 300000)
   C. Port configurable via `PORT` env var (default 3009); full env list as B
   D. Other: [please specify]

   **Answer:** C — full env list per option B; port via `PORT` with default 3009

3. The `lru-cache` package is the standard Node.js LRU implementation. Should the cache key use a plain string concatenation or an actual SHA-256 hash of the cache key components?
   A. SHA-256 hash as specified — prevents accidental cache collisions if any component contains the `|` separator character
   B. Plain string: `${metric_family}|${period}|${sorted_location_ids.join(',')}` — simpler, separators are safe in practice
   C. Normalized JSON stringify of `{ metric_family, period, location_ids: sorted }` — no special separator needed
   D. Other: [please specify]

   **Answer:** A — use SHA-256 as specified in Section 3.3 to match the spec exactly; import from `node:crypto`

4. The `metrics-calculator.ts` fans out parallel Analytics Service calls. Should it use `Promise.all` (fail-fast on any error) or `Promise.allSettled` (partial results on partial failure)?
   A. `Promise.all` — if any Analytics Service call fails, the entire request fails with a 502; no partial KPI responses
   B. `Promise.allSettled` — return available KPIs and mark missing metric families as `null` in the response; log the failed calls at `warn`
   C. `Promise.all` with a per-call timeout (5s); any timeout is treated as a service unavailability error
   D. Other: [please specify]

   **Answer:** A — use `Promise.all`. The spec does not define partial KPI responses, and returning inconsistent partial data (e.g. ROAS without ad spend) would be misleading. Fail the request cleanly with 502 and let the client retry.

5. The `analytics-client.ts` makes authenticated calls using `ANALYTICS_API_KEY`. Should it be a simple `fetch`-based client or use a library, and should it include retry logic?
   A. Plain `fetch` (Node 18+/24 built-in), no retry — failures propagate as 502 to the caller; upstream retries are the caller's responsibility
   B. Plain `fetch` with one retry on 5xx/timeout (exponential back-off: 500ms → 1000ms) — absorbs transient Analytics Service blips without surfacing to users
   C. Use `undici` directly for better performance; no retry
   D. Plain `fetch` with a configurable timeout via `AbortController` (default 10s); one retry on network error; no retry on 4xx/5xx
   D. Other: [please specify]

   **Answer:** B — plain `fetch` with one retry on 5xx/network error; 10s timeout via `AbortController`. Transient errors are common in distributed systems; one retry absorbs them without overloading Analytics Service.

6. Puppeteer runs headless Chromium inside an ECS Fargate container. What Chromium launch arguments are required for the containerized environment?
   A. `--no-sandbox`, `--disable-setuid-sandbox`, `--disable-dev-shm-usage` — standard set for Docker/ECS environments where `/dev/shm` is limited and no sandbox is needed
   B. `--no-sandbox`, `--disable-setuid-sandbox` only — ECS Fargate provides adequate `/dev/shm`
   C. No special args — use `puppeteer-core` with the pre-installed Chromium path; ECS Fargate handles the rest
   D. Other: [please specify]

   **Answer:** A — use `--no-sandbox`, `--disable-setuid-sandbox`, `--disable-dev-shm-usage`. These are the canonical Puppeteer Docker args. ECS Fargate `/dev/shm` is 64MB by default; `--disable-dev-shm-usage` writes to `/tmp` instead, preventing Chromium crashes on larger pages.

7. Handlebars templates are bundled into the Docker image at build time. How should `pdf-generator.ts` load them — via `fs.readFileSync` at startup, or at job-execution time?
   A. Load and compile all 5 templates at module initialization (`import` time) using `Handlebars.compile()` — templates become in-memory compiled functions; zero I/O per job
   B. Read the template file with `fs.readFileSync` on each job execution, then compile — simple but redundant I/O per report
   C. Load templates lazily on first use per report type and cache the compiled function — good balance
   D. Other: [please specify]

   **Answer:** A — compile all 5 templates at module init. Templates are small and static; eager loading gives zero runtime I/O overhead and fails fast at startup if a template file is missing.

8. The spec says `report_schedule_id` is null for on-demand runs, and on-demand completion triggers `POST /notifications/publish`. Should the notification also fire for scheduled runs (where a staff member may not be watching)?
   A. No — notifications are only for on-demand runs as specified; scheduled runs only send emails (Section 5.1 step 7)
   B. Yes — notify `triggered_by='scheduler'` channel on scheduled completions too; use a system channel like `broadcast:location:{location_id}`
   C. Yes — but only if the schedule has a designated `notify_user_id` field (not in current schema); defer to a future schema amendment
   D. Other: [please specify]

   **Answer:** A — spec is explicit: `POST /notifications/publish` fires only when `report_schedule_id is null` (on-demand). Scheduled runs deliver via email. Do not add behavior beyond what is specified.

9. The `generate-report` BullMQ job has 2 retry attempts with exponential backoff. What should the backoff delays be, and should the queue use a dead-letter pattern?
   A. Attempt 1: immediate; attempt 2: 30s delay; attempt 3 (final failure): update `report_run` to `status=failed`. No DLQ — the `report_runs` table serves as the failure log.
   B. Attempt 1: 5s; attempt 2: 30s; attempt 3: 2 min; after 3 failures: move to a BullMQ `failed` set (BullMQ default) and update `report_run` to `status=failed`
   C. Two retries with exponential back-off as spec'd: 5s → 25s; after the final failure: update `report_run` to `status=failed`, do not use BullMQ DLQ (the DB row is the record)
   D. Other: [please specify]

   **Answer:** C — two retries (total 3 attempts) with exponential backoff starting at 5s. The `report_runs` table is the authoritative failure log; BullMQ's `failed` set provides operational visibility but is not the source of truth. BullMQ default `removeOnFail: false` retains the job for inspection.

10. Section 6.1 specifies startup reconciliation for Redis flush recovery. Should this reconciliation run synchronously blocking server startup, or asynchronously in the background after startup?
    A. Synchronous and blocking — server does not serve traffic until reconciliation is complete; prevents scheduling gaps immediately after deploy
    B. Asynchronous — server starts, then reconciliation runs in the background; a missed schedule window during the brief gap is acceptable
    C. Synchronous with a timeout (10s max) — if reconciliation takes longer than 10s (e.g. slow Redis), log a warning and continue startup
    D. Other: [please specify]

    **Answer:** A — run reconciliation synchronously before `app.listen()`. Reconciliation is a lightweight read-then-conditional-write (only schedules missing from BullMQ are re-registered). The spec says "on service startup" — blocking ensures correctness. It cannot cause a significant delay in practice.

11. When a user calls `POST /reporting/report-configs/:id/generate`, the service pre-creates a `report_run` row with `status=pending` and enqueues a BullMQ job. What is the response body and status code?
    A. `201 Created` with `{ run_id: "uuid" }` — mirrors a resource-creation pattern
    B. `202 Accepted` with `{ run_id: "uuid" }` — semantically correct for async operations; spec states "returns `{ run_id }`"
    C. `200 OK` with `{ run_id: "uuid" }` — simpler, consistent with query endpoints
    D. Other: [please specify]

    **Answer:** B — `202 Accepted` is the correct HTTP status for an accepted but not yet completed async operation. The spec states `→ { run_id }`.

12. The `/reporting/runs/:id/download` endpoint redirects to a Media Service presigned URL. Should it use a 302 (temporary redirect) or 307 (temporary redirect preserving method)?
    A. `302 Found` — standard browser/client redirect; acceptable since all downstream clients will GET the presigned URL
    B. `307 Temporary Redirect` — preserves method semantics; more correct per HTTP spec for non-GET original requests
    C. Return `200` with `{ url: "<presigned_url>" }` — simpler for API clients than following redirects
    D. Other: [please specify]

    **Answer:** A — `302 Found` as spec explicitly states. The endpoint is `GET`-only and the spec says "302 redirect." API clients that cannot follow redirects will need to handle this, but the spec is clear.

13. What should the `location_id` parameter be on the `POST /media/internal/store` call when a report covers multiple locations (Section 5.3)?
    A. `null` as specified — multi-location reports are stored without a location prefix in Media Service
    B. A synthetic value like `"multi-location"` — helps with Media Service storage organization
    C. The `created_by` user's primary location — piggybacks the caller's location for access control
    D. Other: [please specify]

    **Answer:** A — spec is explicit: `location_id: parameters.location_ids[0] if exactly one location, else null`. No interpretation needed.

14. `GET /reporting/metrics/location-comparison` includes a `network_average` computed across **all** locations regardless of the caller's location filter. How should this be implemented when `call_center_manager` passes a subset of `location_ids`?
    A. Make two separate calls to Analytics Service: one filtered to the caller's permitted locations (for their data), one with no location filter (for network average) — run in parallel
    B. Make one call with the caller's location filter, then a second call with no filter for network average — always two calls
    C. Cache the network average separately with a global cache key (no location scope) — single Analytics Service call for network; merge results
    D. Other: [please specify]

    **Answer:** A — two parallel calls: one scoped to caller's permitted locations, one unfiltered for network average. `call_center_manager` roles get `network_average: null` per spec Section 4.1, so the second call only fires for `marketing_staff` and above. Simpler to branch on role before making the second call.

15. The spec states `call_center_manager` and `call_center_agent` receive `network_average: null` from the location-comparison endpoint. Should the service skip the all-locations Analytics call entirely for those roles, or make the call and then strip the result?
    A. Skip the call entirely for `call_center_agent` and `call_center_manager` — no wasted network round-trip; return `network_average: null` directly
    B. Always make the call; strip result based on role — simpler code path, slightly wasteful
    C. Other: [please specify]

    **Answer:** A — skip the call for location-scoped roles. It avoids an unnecessary Analytics Service call and respects the access control boundary. Check `req.user.role` before deciding whether to make the second call.

16. The `coordinator_id` filter on `GET /reporting/metrics/coordinator-performance` is overwritten to `req.user.sub` for `call_center_agent` callers. What should happen if a `call_center_agent` passes a `coordinator_id` that matches their own `sub`?
    A. Allow it — overwriting `sub` with `sub` is a no-op; consistent behavior
    B. Reject with `403 { error: "forbidden" }` — agents should not be querying by coordinator ID at all
    C. Silently overwrite regardless of what they pass — no validation needed
    D. Other: [please specify]

    **Answer:** A — overwrite unconditionally with `req.user.sub`. The result is the same as the agent querying their own data. No need for special-case validation; keep the code path simple.

17. How should the `period` query parameter be parsed and validated? The spec shows two formats: `YYYY-MM` (full month) and `YYYY-MM-DD/YYYY-MM-DD` (custom range). Should there be a max range cap?
    A. Parse both formats; max custom range of 366 days (one year); reject with `400` if exceeded; `YYYY-MM` always resolves to full calendar month
    B. Parse both formats; no max range cap — Analytics Service query performance is its own concern
    C. Parse both formats; max 90 days for `daily` granularity; no cap for `monthly` granularity
    D. Other: [please specify]

    **Answer:** A — validate both formats; enforce a 366-day cap on custom ranges to prevent runaway Analytics Service queries. The Reporting Service owns this boundary since Analytics Service has no built-in range cap. Return `400 { error: "invalid_period", message: "Custom period cannot exceed 366 days" }`.

18. What HTTP status code and body should metric endpoints return when Analytics Service is unreachable or returns 5xx?
    A. `502 Bad Gateway` with `{ error: "upstream_unavailable", upstream: "analytics" }` — indicates the Reporting Service itself is healthy but a dependency is not
    B. `503 Service Unavailable` — generic service failure
    C. `500 Internal Server Error` — internal failure, let the client retry
    D. Other: [please specify]

    **Answer:** A — `502 Bad Gateway` with structured error body including the `upstream` field. This allows clients (including the CRM frontend) to distinguish Reporting Service failures from dependency failures and display appropriate messages.

19. The `GET /reporting/report-configs` endpoint returns the caller's own configs, unless `?all=true` is passed by a `marketing_manager+`. What is the response shape, and should it support filtering/sorting?
    A. `200` with `{ data: ReportConfig[] }` — no pagination, no sorting; config counts are low (tens per user, hundreds system-wide); return all
    B. `200` with `{ data: ReportConfig[], total: N }` — include total for client-side display
    C. `200` with `{ data: ReportConfig[] }` plus `?type=` filter (by `report_type`) and default sort by `created_at DESC` — consistent with index hints in schema
    D. Other: [please specify]

    **Answer:** C — return `{ data: ReportConfig[] }` sorted `created_at DESC` by default (matches the schema index). Add optional `?type=` filter for report type. No pagination — report config volumes are bounded and low.

20. The `report_schedules.recipient_emails` is a `text[]` column. Should the Reporting Service validate that recipient emails are well-formed on `POST /reporting/schedules`?
    A. Yes — validate each email with a basic RFC-compliant regex; reject `400` if any are malformed
    B. Yes — validate format AND that each email corresponds to a CRM user (call Identity Service `GET /identity/users?email=`); reject `400` if any are unknown
    C. No validation — Email Service will handle bounce/failure; validation adds coupling without clear value at the Reporting Service level
    D. Other: [please specify]

    **Answer:** A — validate email format only (basic regex, not RFC full spec). The spec says "All report recipients must be CRM users (v1 scope)" but does not require the Reporting Service to verify this against Identity Service. Format validation catches obvious typos without adding cross-service coupling. Note the v1 constraint in a code comment.

21. What TypeBox schemas should be created, and should they be colocated with routes or in a shared `src/schemas/` directory?
    A. One schema file per route module, colocated in `src/routes/` — keeps route definition and validation together
    B. Shared `src/schemas/` directory with one file per domain entity (`report-config.ts`, `schedule.ts`, `run.ts`, `revenue-config.ts`) — avoids duplication when the same shape appears in multiple routes
    C. Inline TypeBox schemas directly in the Fastify route definition — most compact, no separate files
    D. Other: [please specify]

    **Answer:** B — `src/schemas/` directory with per-entity files. The same shapes (e.g. `ReportConfigParams`, `ScheduleBody`) appear in both `POST` and `PUT` handlers; shared schemas eliminate duplication and are easier to locate. Route files import from `../schemas/`.

22. What is the expected test strategy for this service?
    A. Unit tests for `metrics-calculator.ts` (mock Analytics client), `pdf-generator.ts` (mock Puppeteer), `csv-generator.ts`, `schedule-manager.ts` (mock BullMQ); integration tests for all route handlers against a real DB with mocked downstream services
    B. Unit tests only — no integration tests in this iteration; all downstream calls mocked
    C. Integration tests only — spin up Postgres + Redis in Vitest; HTTP inject for all routes; mock only Puppeteer and external HTTP calls
    D. Other: [please specify]

    **Answer:** A — unit tests for pure computation/generation modules (calculator, generators, schedule manager); integration tests for routes using a real test DB + mocked HTTP clients (Analytics, Media, Email, Notification services). Puppeteer is always mocked in tests — launching Chromium in CI is fragile and slow. BullMQ jobs are tested by enqueuing and processing with a real Redis test instance.

23. The spec defines a `SERVICE_CALLER_ID` sentinel UUID for Media Service uploads. Should this be a hardcoded constant in the service, or an environment variable?
    A. Hardcoded constant in `src/services/report-renderer.ts` (e.g. `const SERVICE_CALLER_ID = '00000000-0000-0000-0000-000000reporting'`) — the sentinel is service-specific and not meant to be configurable
    B. Environment variable `SERVICE_CALLER_ID` — allows it to be overridden per environment without code changes
    C. Read from the Media Service spec/shared constants package — single source of truth
    D. Other: [please specify]

    **Answer:** A — hardcoded as a named constant in the service. The sentinel UUID is an internal Media Service convention for service-initiated uploads, not an operator-configurable value. Putting it in env vars implies it needs to change — it doesn't.

24. The spec says `PUT /reporting/schedules/:id` replaces the BullMQ repeatable job (remove old + add new). What happens if the new `queue.add()` fails after the old job is removed?
    A. Wrap remove + add in a try/catch; if `add` fails, re-add the old job configuration and return `500` — best-effort rollback
    B. Accept the gap — the startup reconciliation will re-register the job on the next deploy; log the failure at `error` level and return `500`
    C. Perform the DB update first; only update BullMQ if DB succeeds; on BullMQ failure, return `500` but leave DB updated — the startup reconciliation will fix BullMQ on next restart
    D. Other: [please specify]

    **Answer:** C — DB is the source of truth. Update DB first; then update BullMQ. If BullMQ update fails after DB succeeds, log at `error`, return `500`, and rely on startup reconciliation to re-register the missing repeatable job. Do not attempt in-process rollback of the BullMQ operation — startup reconciliation is the designed recovery path.

25. Should the service expose a health/readiness endpoint for ECS health checks?
    A. `GET /health` returning `200 { status: "ok" }` (liveness only)
    B. `GET /health` (liveness) + `GET /ready` checking DB connectivity and Redis reachability
    C. `GET /health` only, but it checks DB + Redis as part of the response
    D. Other: [please specify]

    **Answer:** B — `GET /health` returns `200 { status: "ok" }` unconditionally (ECS uses this for container health). `GET /ready` runs `SELECT 1` on Postgres and a Redis `PING` before returning `200`. Separating liveness from readiness prevents ECS from killing a temporarily DB-disconnected container that would otherwise self-recover.

26. The spec references five named report types (`weekly_summary`, `monthly_executive`, `channel_deep_dive`, `coordinator_productivity`, `lead_source`). Should there be a TypeScript enum or string literal union for these, and should the DB column have a CHECK constraint?
    A. TypeScript string literal union type (`type ReportType = 'weekly_summary' | 'monthly_executive' | ...`) in schemas; DB `CHECK` constraint in migration for defense in depth
    B. TypeScript enum only; no DB constraint — TypeBox validation at the API layer is sufficient
    C. Plain strings throughout; no enum or constraint — report types may evolve; keep it open
    D. Other: [please specify]

    **Answer:** A — string literal union in TypeScript (not `enum` — consistent with TypeBox patterns in the codebase) and a DB `CHECK` constraint in the migration. Defense in depth: if a bug bypasses TypeBox validation, the DB rejects invalid values. The union type lives in `src/schemas/report-config.ts`.

27. The spec says `GET /reporting/config/revenue` lists rows scoped to caller's permitted locations, but `location_revenue_config` stores `location_id` as an opaque string with no `created_by`. How should location scoping be applied for `call_center_agent` (one location) and `call_center_manager` (N locations)?
    A. Filter by `WHERE location_id = ANY($1)` passing `req.user.locations`; for `marketing_manager+` (empty `locations` array), return all rows — same `locations[] = []` = all-locations semantics as used elsewhere
    B. For `marketing_manager+`, omit the `WHERE` clause entirely rather than passing an empty array; for others, filter as in A
    C. Same as B — this is consistent with how the spec handles `locations[] = []` in Section 3.1 (omit the param, not pass empty)
    D. Other: [please specify]

    **Answer:** C — use `WHERE location_id = ANY($1)` for location-scoped roles; omit the clause entirely for `marketing_manager+` (those with `locations: []`). This matches the spec's `locations[] = []` handling pattern in Section 3.1 and prevents returning zero rows when an empty array is passed.

## Additional Context

The Reporting Service is the last product-layer service to be implemented before the CRM API Gateway and Web App. All upstream services it depends on (Analytics, Media, Email, Notification, Identity) have approved specs. The Analytics Service amendments in Section 8 of the reporting spec (new `metrics_coordinators_daily` table, `GET /analytics/metrics/coordinators` endpoint, and API key auth pre-middleware) must be considered as separate amendment tasks applied to the already-built Analytics Service before or concurrently with this service's implementation.
