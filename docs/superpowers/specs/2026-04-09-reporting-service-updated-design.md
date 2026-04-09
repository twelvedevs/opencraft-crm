# Reporting Service — Updated Design Spec

**Date:** 2026-04-09
**Status:** Approved
**Supersedes:** `docs/superpowers/specs/2026-03-25-reporting-service-design.md`
**Scope:** Product-layer Reporting Service — Ortho-specific KPI computation, analytics dashboard API, report configuration, scheduled PDF/CSV delivery. Incorporates all clarifications from the 27-question Q&A session.

---

## 1. Overview

The Reporting Service is a **product-layer service** (`apps/crm/reporting`) that computes Ortho-specific KPIs from Analytics Service data and delivers formatted reports to staff.

**Core responsibilities:**
- Compute derived KPIs (cost per case, ROAS, funnel rates, coordinator metrics) by combining Analytics Service responses
- Serve the analytics dashboard via REST endpoints with a 5-min in-process LRU cache
- Manage parameterized report configurations (5 named report types, each configurable with period/location/channel filters)
- Schedule and deliver reports — BullMQ repeatable jobs generate PDF or CSV, store files in S3 via Media Service, deliver download links via Email Service
- Store per-location average contract value for revenue and ROAS computation

**What it does NOT do:**
- Subscribe to any EventBridge events — it is a pure query consumer
- Store metrics or rollup tables of its own
- Call SendGrid, S3, or Twilio directly — uses Email Service and Media Service
- Enforce location access control in Analytics Service — enforces it locally before making those calls

**Architecture choice:** Thin query-time computation layer. All KPIs computed on each request by calling Analytics Service endpoints in parallel (`Promise.all` — fail-fast on any error) and computing ratios. A 5-min in-process LRU cache absorbs repeated dashboard loads from concurrent users. No background pre-computation jobs, no secondary metrics store.

### 1.1 Process Entry Point

`index.ts` unconditionally boots both the Fastify HTTP server and the BullMQ worker in the same process. No `WORKER_ONLY` flag or separate `worker.ts` entry point. The HTTP server and BullMQ worker co-exist in every ECS task deployment.

### 1.2 Environment Variables

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3009` | HTTP listen port |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `REDIS_URL` | — | Redis connection string (BullMQ) |
| `ANALYTICS_SERVICE_URL` | — | Base URL of Analytics Service |
| `ANALYTICS_API_KEY` | — | `ak_`-prefixed Identity Service API key for Analytics Service calls |
| `MEDIA_SERVICE_URL` | — | Base URL of Media Service |
| `INTERNAL_API_SECRET` | — | Shared secret for Media Service internal endpoints |
| `EMAIL_SERVICE_URL` | — | Base URL of Email Service |
| `NOTIFICATION_SERVICE_URL` | — | Base URL of Notification Service |
| `CRM_BASE_URL` | — | Public CRM URL (used for report download links in emails) |
| `IDENTITY_JWKS_URL` | — | JWKS endpoint for JWT verification via `@ortho/auth-middleware` |
| `LOG_LEVEL` | `info` | Pino log level |
| `LRU_CACHE_MAX` | `500` | Max entries in the metrics LRU cache |
| `LRU_CACHE_TTL_MS` | `300000` | LRU cache TTL in milliseconds (5 minutes) |

`SERVICE_CALLER_ID` is **not** an environment variable — it is a hardcoded constant in `report-renderer.ts` (see Section 5.3).

---

## 2. Storage Schema

Schema: `crm_reporting`. Four tables — configuration and operational state only. No metrics tables.

### 2.1 `location_revenue_config`

Per-location average contract value used for revenue and ROAS computation.

```sql
location_id         text           PRIMARY KEY
avg_contract_value  numeric(10,2)  NOT NULL
updated_at          timestamptz    NOT NULL DEFAULT now()
updated_by          text           NOT NULL  -- JWT sub of updating user
```

### 2.2 `report_configs`

Saved parameterized report definitions.

```sql
id           uuid        PRIMARY KEY DEFAULT gen_random_uuid()
name         text        NOT NULL
report_type  text        NOT NULL
             CHECK (report_type IN (
               'weekly_summary', 'monthly_executive', 'channel_deep_dive',
               'coordinator_productivity', 'lead_source'
             ))
parameters   jsonb       NOT NULL DEFAULT '{}'
             -- {
             --   period_type: 'last_30d' | 'last_month' | 'custom',
             --   from?: 'YYYY-MM-DD',
             --   to?: 'YYYY-MM-DD',
             --   location_ids?: string[],
             --   channel?: string[]
             -- }
created_by   text        NOT NULL
created_at   timestamptz NOT NULL DEFAULT now()
updated_at   timestamptz NOT NULL DEFAULT now()
```

**TypeScript type:** `type ReportType = 'weekly_summary' | 'monthly_executive' | 'channel_deep_dive' | 'coordinator_productivity' | 'lead_source'` — string literal union (not `enum`). Defined in `src/schemas/report-config.ts`. The DB `CHECK` constraint provides defense-in-depth if TypeBox validation is bypassed.

**Indexes:**
- `INDEX (created_by)` — supports `GET /reporting/report-configs` filtered by caller
- `INDEX (created_at DESC)` — supports time-ordered listing for `marketing_manager` all-configs view

### 2.3 `report_schedules`

Delivery schedule per saved report config.

```sql
id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid()
report_config_id   uuid        NOT NULL REFERENCES report_configs(id) ON DELETE CASCADE
frequency          text        NOT NULL   -- daily | weekly | monthly
day_of_week        int                    -- 0–6 (weekly only; 0 = Sunday), null otherwise
day_of_month       int                    -- 1–28 (monthly only), null otherwise
hour_utc           int         NOT NULL   -- 0–23
recipient_emails   text[]      NOT NULL
format             text        NOT NULL DEFAULT 'pdf'  -- pdf | csv
active             boolean     NOT NULL DEFAULT true
created_by         text        NOT NULL
created_at         timestamptz NOT NULL DEFAULT now()
```

### 2.4 `report_runs`

Immutable log of every generation attempt (scheduled and on-demand).

```sql
id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid()
report_config_id    uuid        NOT NULL REFERENCES report_configs(id)
report_schedule_id  uuid        REFERENCES report_schedules(id)  -- null = on-demand
triggered_by        text        NOT NULL   -- user_id or 'scheduler'
format              text        NOT NULL   -- pdf | csv
status              text        NOT NULL   -- pending | running | done | failed
media_file_id       text                   -- Media Service file_id, set on success
error_message       text                   -- set on failure
started_at          timestamptz NOT NULL DEFAULT now()
completed_at        timestamptz
recipient_emails    text[]
```

**Indexes:** `INDEX (report_config_id, started_at DESC)` — supports `GET /reporting/runs?config_id=` with time-ordered results.

---

## 3. Metrics Computation

### 3.1 Analytics Service Calls

On each dashboard or metric request, `metrics-calculator.ts` fans out parallel calls to the Analytics Service using `Promise.all`. If any call fails, the entire request fails with `502 Bad Gateway`. No partial KPI responses — returning incomplete data (e.g. ROAS without ad spend) would be misleading.

| Call | Endpoint | Used for |
|---|---|---|
| Lead counts by channel | `GET /analytics/metrics/leads` | Leads generated, cost per lead |
| Stage entries by stage | `GET /analytics/metrics/pipeline` | Exam conversion rate, exam show rate, case conversion rate |
| Conversion counts by channel | `GET /analytics/metrics/conversions` | Cost per case, ROAS, revenue attributed |
| Ad spend by platform + campaign | `GET /analytics/metrics/ad-spend` | All cost metrics |
| Coordinator stats | `GET /analytics/metrics/coordinators` | Coordinator performance *(new endpoint — see Section 8.2)* |
| Campaign stats | `GET /analytics/metrics/campaigns` | Campaign analytics report |

All calls pass through the same `period`, `location_id[]`, and `granularity` params received from the caller. Location access control is enforced before these calls — the Analytics Service receives only the location IDs the caller is permitted to see.

**`locations[] = []` handling:** When the caller's JWT has `locations[] = []` (`marketing_staff` or `marketing_manager`, meaning all-locations access), the Reporting Service omits the `location_id` parameter entirely when calling Analytics Service endpoints — it does NOT pass an empty array. Passing an empty array would return zero results.

**Service-to-service auth:** All calls to Analytics Service use the `ANALYTICS_API_KEY` environment variable (an `ak_`-prefixed Identity Service API key). Included as `Authorization: Bearer ak_<key>`. This applies to both synchronous dashboard requests and asynchronous scheduled report jobs.

### 3.2 Analytics HTTP Client (`analytics-client.ts`)

Plain `fetch` (Node 24 built-in) with:
- **Timeout:** 10s via `AbortController` — applied to every request
- **Retry:** one retry on 5xx responses or network errors, with exponential backoff: 500ms initial delay → 1000ms second delay. No retry on 4xx responses.
- **Error propagation:** After retry exhaustion, throws to the caller; `metrics-calculator.ts` lets the error propagate through `Promise.all` as a 502.

### 3.3 Computed KPIs

| KPI | Formula |
|---|---|
| Cost per lead | `sum(ad_spend) ÷ sum(leads)` — by channel |
| Exam conversion rate | `stage_entries(exam_scheduled) ÷ leads_count` |
| Exam show rate | `stage_entries(exam_completed) ÷ stage_entries(exam_scheduled)` |
| Case conversion rate | `conversions_count ÷ stage_entries(exam_completed)` |
| Cost per exam | `sum(ad_spend) ÷ stage_entries(exam_completed)` |
| Cost per case start | `sum(ad_spend) ÷ conversions_count` — primary KPI |
| Revenue attributed | `conversions_count × avg_contract_value` (from `location_revenue_config`) |
| ROAS | `revenue_attributed ÷ sum(ad_spend)` |
| Lead response time | Average `response_time_seconds` from coordinator rollup |
| Time in stage | Average `time_in_stage_seconds` from coordinator rollup |

**Channel → spend attribution:** `google_ads` leads attributed to `google_ads` platform spend; `facebook` leads attributed to `facebook_ads` spend. Each channel's cost metrics are computed independently — cross-platform spend is never blended.

**Division by zero:** All ratio KPIs return `null` (not `0` or error) when the denominator is zero. The frontend renders `null` as `—`.

**Missing `location_revenue_config`:** If a location has no configured average contract value, `revenue_attributed` and `ROAS` are returned as `null` for that location. The API response includes a `missing_revenue_config: string[]` field listing affected location IDs.

### 3.4 Caching

An in-process LRU cache (`lru-cache` package, max entries from `LRU_CACHE_MAX`, TTL from `LRU_CACHE_TTL_MS`) wraps `metrics-calculator.ts` in `metrics-cache.ts`.

- **Cache key:** `sha256(metric_family + '|' + period + '|' + sorted(location_ids).join(','))` — computed via `createHash('sha256')` from `node:crypto`. SHA-256 prevents cache collisions if any component contains the `|` separator.
- **Cache miss:** triggers all parallel Analytics Service calls; result stored before returning
- **Cache scope:** per ECS instance — no shared state across tasks. Acceptable given the 5-min TTL and typical single-session dashboard load patterns
- **No manual invalidation:** TTL expiry is the only eviction mechanism

---

## 4. API

All routes served via the CRM API Gateway. JWT required on every endpoint via `@ortho/auth-middleware`.

**Location access control** (enforced by Reporting Service, not Analytics Service):
- `call_center_agent`: own location only
- `call_center_manager`: assigned locations only
- `marketing_staff`, `marketing_manager`: all locations (JWT `locations: []` → omit filter param)

### 4.1 Period Parameter Validation

All metric endpoints accept a `period` query parameter in two formats:
- `YYYY-MM` — resolves to the full calendar month (first day to last day)
- `YYYY-MM-DD/YYYY-MM-DD` — custom date range

**Validation rules:**
- Both formats must be parseable; return `400 { error: "invalid_period", message: "..." }` if malformed
- Custom ranges are capped at **366 days**; exceeding this returns `400 { error: "invalid_period", message: "Custom period cannot exceed 366 days" }`
- The Reporting Service owns this boundary — the Analytics Service has no built-in range cap

### 4.2 Upstream Error Responses

When the Analytics Service is unreachable or returns 5xx (after retry exhaustion):

```json
HTTP 502 Bad Gateway
{ "error": "upstream_unavailable", "upstream": "analytics" }
```

This allows CRM frontend clients to distinguish Reporting Service failures from dependency failures.

### 4.3 Dashboard & Metrics

```
GET /reporting/dashboard
    ?period=YYYY-MM | YYYY-MM-DD/YYYY-MM-DD
    &location_id[]=...
    &granularity=daily|monthly|total
    → 200 { period, granularity, kpis: {...}, missing_revenue_config: [...] }

GET /reporting/metrics/channel-performance
    → leads, funnel rates, and cost metrics broken down by channel

GET /reporting/metrics/location-comparison
    → per-location KPIs + network_average object

GET /reporting/metrics/coordinator-performance
    ?coordinator_id=...   (optional)
    → per-coordinator: stage_transitions, exams_booked, conversions, avg_response_time_seconds

GET /reporting/metrics/campaign-analytics
    → sent, delivered, opened, clicked, conversion rate per email campaign
```

All metric endpoints accept `period`, `location_id[]`, `granularity`. Metric-specific additional filters are passed through after access-control filtering.

**`location-comparison` — `network_average` implementation:**

`network_average` benchmarks all locations regardless of the caller's location filter. Implementation:
1. For `call_center_agent` and `call_center_manager`: skip the all-locations call entirely; return `network_average: null`. No Analytics Service round-trip for the network average.
2. For `marketing_staff` and `marketing_manager`: fire two parallel calls — one filtered to the caller's permitted locations (for their data), one with no location filter (for network average). Merge results before returning.

**`coordinator-performance` access control:**
- `call_center_agent`: `coordinator_id` filter is unconditionally overwritten with `req.user.sub`. Whether the agent passes their own sub, a different sub, or omits the param entirely, the result is the same — their own metrics only.
- `call_center_manager` and marketing roles: may pass any `coordinator_id` within their permitted locations.

### 4.4 Report Configs

```
GET    /reporting/report-configs
           ?type=weekly_summary|monthly_executive|channel_deep_dive|coordinator_productivity|lead_source
           ?all=true  (marketing_manager+ only)
       → 200 { data: ReportConfig[] }   sorted created_at DESC, no pagination

POST   /reporting/report-configs              → 201 { id, ...config }
PUT    /reporting/report-configs/:id          → 200 { id, ...config }
DELETE /reporting/report-configs/:id          → 204
POST   /reporting/report-configs/:id/generate
           ?format=pdf|csv  (default: pdf)
       → 202 { run_id }
```

**Response shape for list endpoint:** `{ data: ReportConfig[] }` sorted `created_at DESC`. Optional `?type=` filter by `report_type` (string literal union). No pagination — config volumes are bounded and low.

**Role-based access:**
- All roles may create configs. Location-scoped roles may only create configs whose `parameters.location_ids` are within their permitted locations.
- `GET /reporting/report-configs` returns only the caller's own configs unless `all=true` is passed by `marketing_manager+`.
- `marketing_manager+` may update and delete any config regardless of `created_by`.

**On-demand generate:** Enqueues job and returns `202 Accepted` with `{ run_id }` immediately. Caller polls `GET /reporting/runs/:id` at recommended 2s interval. If not `done` or `failed` within 5 minutes, frontend surfaces a timeout message. Alternatively, run completion is pushed via Notification Service — the `generate-report` job calls `POST /notifications/publish` with the requesting user's channel on completion, eliminating polling.

### 4.5 Schedules

**Recipient email validation (on `POST /reporting/schedules`):** Each email in `recipient_emails` is validated against a basic format regex. Malformed addresses return `400`. The Reporting Service does **not** verify emails against Identity Service — format validation catches obvious typos without cross-service coupling. The v1 constraint that all recipients must be CRM users is noted in a code comment but not enforced at this layer.

```
GET    /reporting/schedules                   → list schedules for caller's configs
POST   /reporting/schedules                   → create schedule → registers BullMQ repeatable job
PUT    /reporting/schedules/:id               → update → DB first, then BullMQ replacement
DELETE /reporting/schedules/:id               → delete → removes BullMQ job
```

**Schedule update failure handling (`PUT /reporting/schedules/:id`):** DB is the source of truth.
1. Update DB row first
2. Remove old BullMQ repeatable job + add new one
3. If BullMQ update fails after DB succeeds: log at `error`, return `500`, rely on startup reconciliation to re-register the job on next restart. No in-process rollback attempted.

### 4.6 Report Runs

```
GET   /reporting/runs                          → run history; filterable by ?config_id=
GET   /reporting/runs/:id                      → single run status
GET   /reporting/runs/:id/download             → 302 redirect to fresh Media Service presigned URL
POST  /reporting/runs/:id/retry                → re-enqueue a failed run
                                                requires run.status = 'failed'
                                               → 202 { run_id }  (new run_id)
```

**`/download`:** Returns `302 Found` (as spec'd — all callers `GET` the presigned URL). Requires valid CRM user JWT. Caller must either (a) be the `triggered_by` user of the run, or (b) have location access to all `location_ids` in the run's report config parameters. `marketing_manager+` passes check (b) unconditionally.

**`/retry`:** Same ownership/location-access check as `/download`. Creates a new `report_run` row inheriting `format` and `recipient_emails` from the original failed run. Enqueues a fresh `generate-report` job. Does not mutate the failed run row.

**`GET /reporting/runs?config_id=` authorization:** Verifies the caller has read access to the named `report_config_id` using the same rules as `GET /reporting/report-configs`.

### 4.7 Revenue Configuration

```
GET  /reporting/config/revenue
     → 200 { data: LocationRevenueConfig[] }
     scoped to caller's permitted locations

PUT  /reporting/config/revenue/:location_id
     → 200 { location_id, avg_contract_value, updated_at }
     requires marketing_manager role
```

**Location scoping for `GET`:** Uses `WHERE location_id = ANY($1)` for `call_center_agent` and `call_center_manager` (passing `req.user.locations`). For `marketing_staff` and `marketing_manager` (`locations: []`), omits the `WHERE` clause entirely — consistent with the `locations[] = []` = all-locations pattern used throughout the service.

`location_id` on `PUT` is an opaque string — not validated against real locations. Invalid IDs produce no harm (a config for a non-existent location is never returned in metric queries).

### 4.8 Health Endpoints

```
GET /health  → 200 { status: "ok" }   (unconditional — ECS liveness check)
GET /ready   → 200 { status: "ok" }   (checks DB connectivity + Redis reachability)
             → 503 { status: "unavailable", checks: { db: "fail", redis: "ok" } }
```

`/health` returns `200` unconditionally — ECS uses this to determine whether to replace the container. `/ready` runs `SELECT 1` on Postgres and a Redis `PING`; returns `503` if either fails. Separating liveness from readiness prevents ECS from killing a temporarily DB-disconnected container that would self-recover.

---

## 5. TypeBox Schemas

Location: `src/schemas/` directory with one file per domain entity. Route files import from `../schemas/`. This eliminates duplication when the same shape appears in both `POST` and `PUT` handlers.

| File | Contents |
|---|---|
| `src/schemas/report-config.ts` | `ReportType` string literal union, `ReportConfigBody`, `ReportConfigParams`, `ReportConfigResponse` |
| `src/schemas/schedule.ts` | `ScheduleBody`, `ScheduleResponse` |
| `src/schemas/run.ts` | `RunResponse`, `RunStatus` |
| `src/schemas/revenue-config.ts` | `RevenueConfigBody`, `RevenueConfigResponse` |
| `src/schemas/metrics.ts` | `PeriodParam`, `MetricsQueryParams`, shared metric response shapes |

---

## 6. Report Generation Pipeline

On-demand and scheduled report runs share the same pipeline, implemented in `report-renderer.ts`.

### 6.1 Steps

```
1. Load report_config + parameters from DB
2. Resolve period (e.g. 'last_month' → concrete YYYY-MM-DD/YYYY-MM-DD range)
3. Fetch metrics via metrics-cache.ts (5-min cache applies)
4. Generate document:
   ├── PDF → inject metrics into pre-compiled Handlebars template
   │         → Puppeteer headless Chromium → Buffer
   └── CSV → fast-csv serialize metrics rows → Buffer
5. Upload to S3 via Media Service internal endpoint:
   POST /media/internal/store {
     buffer, filename, content_type,
     location_id: parameters.location_ids[0] if exactly one location, else null
   }
   → { file_id, url }
6. Update report_run: status=done, media_file_id, completed_at
7. If recipient_emails present:
   POST /emails/send {
     to: recipient_emails,
     subject: "<ReportName> — <period>",
     body_html: "<p>Your report is ready:
       <a href='{CRM_BASE_URL}/reporting/runs/{run_id}/download'>Download</a></p>"
   }
   -- Link points to /reporting/runs/:id/download (the 302 endpoint), NOT a presigned URL.
   -- Presigned URLs expire in 15 minutes; the /download endpoint fetches a fresh one on each click.
   -- All recipients must be CRM users (their JWT is required to access /download). [v1 constraint]
8. If run is on-demand (report_schedule_id is null):
   POST /notifications/publish { channel: 'user:{triggered_by}', ... }
   -- Fires regardless of whether recipient_emails are present.
   -- Does NOT fire for scheduled runs — scheduled runs deliver solely via email.
9. On any failure: update report_run: status=failed, error_message
```

### 6.2 Handlebars Templates

Five templates in `templates/` — one per report type. Bundled into the Docker image at build time.

**Template loading:** All five templates are loaded from disk and compiled with `Handlebars.compile()` at **module initialization** (`import` time). Compiled template functions are stored as module-level constants. Zero I/O overhead per job. Service startup fails fast if any template file is missing — preferable to silent per-job failures.

### 6.3 Puppeteer PDF Generation (`pdf-generator.ts`)

A new browser instance is launched per job — no shared browser across concurrent jobs.

**Required Chromium args for ECS Fargate:**
```
--no-sandbox
--disable-setuid-sandbox
--disable-dev-shm-usage
```
`--disable-dev-shm-usage` causes Chromium to write to `/tmp` instead of `/dev/shm` (64MB default in Fargate), preventing crashes on larger pages.

**Safety rules:**
- `page.setDefaultTimeout(30_000)` set immediately after page creation
- Browser closed in a `finally` block regardless of success or failure
- ECS task memory allocation must account for Chromium's ~150MB baseline footprint. Recommended minimum: 512MB per task.

### 6.4 Media Service Integration

Uses the `INTERNAL_API_SECRET` header for authentication. `uploaded_by` is set to the `SERVICE_CALLER_ID` sentinel:

```typescript
// In report-renderer.ts
const SERVICE_CALLER_ID = '00000000-0000-0000-0000-000000reporting'
```

This is a hardcoded constant — not an environment variable. It is an internal Media Service convention for service-initiated uploads, not operator-configurable.

Files are stored in the **private bucket** (presigned GET URLs, 15-min TTL) — report content is business-sensitive.

**`location_id` on upload:** `parameters.location_ids[0]` if the report covers exactly one location, otherwise `null`.

### 6.5 BullMQ Job: `generate-report`

```typescript
interface GenerateReportJob {
  report_config_id: string
  report_run_id: string        // pre-created in DB with status=pending
  format: 'pdf' | 'csv'
  recipient_emails?: string[]
  report_schedule_id?: string  // set for scheduled runs, null for on-demand
}
```

**Queue:** `reporting-jobs`

**Retry config:**
- Total attempts: 3 (2 retries after the initial attempt)
- Backoff: exponential starting at 5s — attempt 2 at 5s delay, attempt 3 at 25s delay
- `removeOnFail: false` — BullMQ retains the failed job for operational visibility
- On final failure: `report_run` row updated to `status=failed, error_message=<last error>`
- The `report_runs` table is the authoritative failure log; BullMQ's `failed` set provides operational visibility only

---

## 7. Scheduled Reports

### 7.1 Schedule Manager (`schedule-manager.ts`)

Maintains a BullMQ repeatable job for every active `report_schedule` row. Job ID is deterministic: `report-schedule:{schedule_id}`.

**Cron expression derivation:**
```
daily   → 0 {hour_utc} * * *
weekly  → 0 {hour_utc} * * {day_of_week}
monthly → 0 {hour_utc} {day_of_month} * *
```

**Lifecycle:**
- `POST /reporting/schedules` → insert DB row → `queue.add(jobId, payload, { repeat: { cron } })`
- `PUT /reporting/schedules/:id` → update DB row first → if DB succeeds, remove old repeatable + add new; on BullMQ failure, log `error`, return 500, rely on startup reconciliation
- `DELETE /reporting/schedules/:id` → set `active=false` in DB → `queue.removeRepeatable(jobId)`
- `PUT /reporting/schedules/:id` with `{ active: false }` → same BullMQ removal; DB row retained for history

**Startup reconciliation (Redis flush recovery):** On service startup, `schedule-manager.ts` runs reconciliation **synchronously before `app.listen()`**. The service does not serve traffic until reconciliation is complete — this ensures no scheduling gaps immediately after a deploy.

Reconciliation steps:
1. Query all `active = true` rows from `report_schedules`
2. Fetch registered repeatable jobs from BullMQ via `queue.getRepeatableJobs()`
3. Re-register any schedule row whose `jobId` is absent from the BullMQ list

This is idempotent and safe to run on every deploy. The operation is lightweight (read-then-conditional-write) and cannot cause a significant startup delay in practice.

### 7.2 Scheduled Job Handler

When a repeatable job fires:
```
1. Load report_schedule + report_config from DB
2. Check schedule.active — if false, acknowledge and skip (safety net for race conditions)
3. Create report_run row (status=pending, triggered_by='scheduler')
4. Enqueue one-off generate-report job with run_id
```

The repeatable job itself is lightweight. The actual PDF/CSV work runs in its own one-off job with independent retry semantics.

---

## 8. Testing Strategy

**Unit tests** (`test/unit/`) for pure computation and generation modules. All downstream calls mocked.

| Module | What to test |
|---|---|
| `metrics-calculator.ts` | KPI formulas, division-by-zero returns `null`, missing revenue config returns `null`, channel attribution logic |
| `pdf-generator.ts` | Puppeteer always mocked — test argument passing, error propagation, `finally` browser close |
| `csv-generator.ts` | Correct row serialization per report type |
| `schedule-manager.ts` | BullMQ mocked — cron expression derivation, lifecycle operations, reconciliation diff logic |
| `analytics-client.ts` | Retry behavior (mock fetch), timeout handling, 4xx pass-through |

**Integration tests** (`test/integration/`) for all route handlers. Real Postgres test DB + real Redis test instance. HTTP clients (Analytics, Media, Email, Notification) mocked. Puppeteer always mocked — launching Chromium in CI is fragile and slow.

Integration test coverage:
- All CRUD operations on `report_configs`, `report_schedules`, `report_runs`, `location_revenue_config`
- Location-scoping enforcement for each role
- Period validation (format parsing, 366-day cap)
- Generate endpoint: `202` response, `report_run` row created, job enqueued
- Download endpoint: `302` redirect, authorization checks
- Retry endpoint: new `report_run` row created, original row unchanged
- BullMQ `generate-report` job handler: enqueue + process with real Redis; assert `report_run` status transitions

---

## 9. Cross-Service Dependencies

| Dependency | Type | Notes |
|---|---|---|
| Analytics Service | REST consumer | All metric endpoint families. Authenticated via `ANALYTICS_API_KEY` (`ak_`-prefixed). `Promise.all` fan-out per request. `fetch` with 10s timeout + 1 retry on 5xx/network error. |
| Media Service | REST (internal) | `POST /media/internal/store` to upload reports. `GET /media/internal/:file_id/signed-url` on each `/download` request. `INTERNAL_API_SECRET` header. |
| Email Service | REST | `POST /emails/send` when `recipient_emails` is present on a run (both scheduled and on-demand). Plain HTML body with `/reporting/runs/:id/download` link — not a presigned URL. |
| Notification Service | REST | `POST /notifications/publish` on on-demand report completion only. Not fired for scheduled runs. |
| Identity Service | JWT + API key | JWT validation on all inbound endpoints via `@ortho/auth-middleware`. `ANALYTICS_API_KEY` for outbound Analytics calls. |
| BullMQ / Redis | Job queue | `reporting-jobs` queue. Repeatable jobs for scheduled delivery. Startup reconciliation before `app.listen()`. |

---

## 10. Pending Amendments

### 10.1 Pipeline Engine Spec

Add two new fields to the `lead.stage_changed` event payload:

1. `response_time_seconds` — seconds elapsed from `lead.created_at` to this transition; populated **only** when `stage_to = 'contacted'`, `null` otherwise
2. `time_in_stage_seconds` — seconds spent in the previous stage; populated on every transition except the first enrollment into a pipeline

Add `triggered_by` field to `lead.converted` event payload. Currently present on `lead.stage_changed` but unconfirmed on `lead.converted`. The Analytics `LeadConvertedHandler` reads it to attribute conversions to coordinators.

### 10.2 Analytics Service Spec

**Add `metrics_coordinators_daily` rollup table:**
```sql
id                         uuid           PRIMARY KEY DEFAULT gen_random_uuid()
date                       date           NOT NULL
location_id                text           NOT NULL
coordinator_id             text           NOT NULL   -- sourced from triggered_by on lead.stage_changed
stage_transitions          int            NOT NULL DEFAULT 0
exams_booked               int            NOT NULL DEFAULT 0   -- stage_to = 'exam_scheduled'
conversions                int            NOT NULL DEFAULT 0   -- from lead.converted
response_time_count        int            NOT NULL DEFAULT 0   -- count of 'contacted' transitions
avg_response_time_seconds  numeric(10,2)            -- maintained via response_time_count
time_in_stage_count        int            NOT NULL DEFAULT 0
avg_time_in_stage_seconds  numeric(10,2)            -- maintained via time_in_stage_count
UNIQUE (date, location_id, coordinator_id)
```

Running mean upsert pattern:
```sql
ON CONFLICT (date, location_id, coordinator_id) DO UPDATE SET
  response_time_count = metrics_coordinators_daily.response_time_count + 1,
  avg_response_time_seconds = (
    COALESCE(metrics_coordinators_daily.avg_response_time_seconds, 0)
      * metrics_coordinators_daily.response_time_count
      + EXCLUDED.avg_response_time_seconds   -- raw scalar from this event
  ) / (metrics_coordinators_daily.response_time_count + 1)
```

Skip coordinator rollup if `triggered_by` is null (automated transitions).

**Add `GET /analytics/metrics/coordinators` endpoint** — same shared `period`/`granularity`/`location_id` params; additional filter: `coordinator_id`. Returns `stage_transitions`, `exams_booked`, `conversions`, `avg_response_time_seconds`, `avg_time_in_stage_seconds` per coordinator per period.

### 10.3 Analytics Service Auth Amendment

The Analytics Service adds a **pre-middleware Fastify plugin** in its own codebase: before passing the request to `@ortho/auth-middleware`, it inspects the `Authorization: Bearer` value — if it begins with `ak_`, it calls `POST /identity/api-keys/validate` (VPC-internal) and attaches a synthetic request context; if not, it passes through to the standard JWT verification path.

`@ortho/auth-middleware` is NOT modified.

### 10.4 Arch Doc

1. Remove Reporting Service from `lead.converted` EventBridge subscribers — Reporting Service does not subscribe to any events.
2. Add `GET /reporting/*` → Analytics Service to the REST call table in Section 3.2.

---

## 11. File Structure

```
apps/crm/reporting/
├── src/
│   ├── routes/
│   │   ├── dashboard.ts
│   │   ├── metrics/
│   │   │   ├── channel-performance.ts
│   │   │   ├── location-comparison.ts
│   │   │   ├── coordinator-performance.ts
│   │   │   └── campaign-analytics.ts
│   │   ├── report-configs.ts
│   │   ├── schedules.ts
│   │   ├── runs.ts
│   │   ├── config.ts
│   │   └── health.ts
│   ├── schemas/                          # TypeBox schemas, one file per domain entity
│   │   ├── report-config.ts              # ReportType union, ReportConfigBody, ReportConfigResponse
│   │   ├── schedule.ts
│   │   ├── run.ts
│   │   ├── revenue-config.ts
│   │   └── metrics.ts                    # PeriodParam, MetricsQueryParams, shared shapes
│   ├── services/
│   │   ├── analytics-client.ts           # fetch + 10s timeout + 1 retry on 5xx/network error
│   │   ├── metrics-calculator.ts         # Promise.all fan-out + KPI arithmetic
│   │   ├── metrics-cache.ts              # LRU wrapping metrics-calculator (SHA-256 key)
│   │   ├── report-renderer.ts            # orchestrates: calc → generate → upload → email
│   │   ├── pdf-generator.ts              # Puppeteer HTML→PDF Buffer; templates compiled at init
│   │   ├── csv-generator.ts              # fast-csv serialization per report type
│   │   ├── email-sender.ts               # calls Email Service with /download link
│   │   └── schedule-manager.ts           # BullMQ repeatable job CRUD + startup reconciliation
│   ├── repositories/
│   │   ├── report-configs.ts
│   │   ├── schedules.ts
│   │   ├── runs.ts
│   │   └── revenue-config.ts
│   ├── jobs/
│   │   └── generate-report.ts            # BullMQ job handler → calls report-renderer
│   └── index.ts                          # boots Fastify + BullMQ worker; reconciliation before listen()
├── templates/
│   ├── weekly-summary.hbs
│   ├── monthly-executive.hbs
│   ├── channel-deep-dive.hbs
│   ├── coordinator-productivity.hbs
│   └── lead-source.hbs
├── migrations/
├── test/
│   ├── unit/
│   │   ├── metrics-calculator.test.ts
│   │   ├── pdf-generator.test.ts
│   │   ├── csv-generator.test.ts
│   │   ├── schedule-manager.test.ts
│   │   └── analytics-client.test.ts
│   └── integration/
│       ├── dashboard.test.ts
│       ├── report-configs.test.ts
│       ├── schedules.test.ts
│       ├── runs.test.ts
│       ├── config.test.ts
│       └── generate-report-job.test.ts
├── Dockerfile
├── package.json
└── tsconfig.json
```
