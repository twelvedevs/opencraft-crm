# Reporting Service — Design Spec

**Date:** 2026-03-25
**Status:** Draft
**Scope:** Product-layer Reporting Service — Ortho-specific KPI computation, analytics dashboard API, report configuration, scheduled PDF/CSV delivery

---

## 1. Overview

The Reporting Service is a **product-layer service** (`apps/crm/reporting`) that computes Ortho-specific KPIs from Analytics Service data and delivers formatted reports to staff.

**Core responsibilities:**
- Compute derived KPIs (cost per case, ROAS, funnel rates, coordinator metrics) by combining Analytics Service responses
- Serve the analytics dashboard via a set of REST endpoints with a 5-min in-process LRU cache
- Manage parameterized report configurations (5 named report types, each configurable with period/location/channel filters)
- Schedule and deliver reports — BullMQ repeatable jobs generate PDF or CSV, store files in S3 via Media Service, deliver download links via Email Service
- Store per-location average contract value for revenue and ROAS computation

**What it does NOT do:**
- Subscribe to any EventBridge events — it is a pure query consumer
- Store metrics or rollup tables of its own
- Call SendGrid, S3, or Twilio directly — uses Email Service and Media Service
- Enforce location access control in Analytics Service — enforces it locally before making those calls

**Architecture choice:** Thin query-time computation layer. All KPIs computed on each request by calling Analytics Service endpoints in parallel and computing ratios. A 5-min in-process LRU cache absorbs repeated dashboard loads from concurrent users. No background pre-computation jobs, no secondary metrics store.

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
             -- weekly_summary | monthly_executive | channel_deep_dive
             --   | coordinator_productivity | lead_source
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

**Indexes:** `INDEX (created_by)` — supports `GET /reporting/report-configs` filtered by caller. `INDEX (created_at DESC)` — supports time-ordered listing for marketing_manager all-configs view.

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

On each dashboard or metric request, `metrics-calculator.ts` fans out parallel calls to the Analytics Service, then computes derived KPIs. All computation is pure arithmetic on pre-aggregated counts.

| Call | Endpoint | Used for |
|---|---|---|
| Lead counts by channel | `GET /analytics/metrics/leads` | Leads generated, cost per lead |
| Stage entries by stage | `GET /analytics/metrics/pipeline` | Exam conversion rate, exam show rate, case conversion rate |
| Conversion counts by channel | `GET /analytics/metrics/conversions` | Cost per case, ROAS, revenue attributed |
| Ad spend by platform + campaign | `GET /analytics/metrics/ad-spend` | All cost metrics |
| Coordinator stats | `GET /analytics/metrics/coordinators` | Coordinator performance *(new endpoint — see Section 7)* |
| Campaign stats | `GET /analytics/metrics/campaigns` | Campaign analytics report |

All calls pass through the same `period`, `location_id[]`, and `granularity` params received from the caller. Location access control is enforced before these calls — the Analytics Service receives only the location IDs the caller is permitted to see.

**`locations[] = []` handling:** When the caller's JWT has `locations[] = []` (marketing_staff or marketing_manager, meaning all-locations access), the Reporting Service omits the `location_id` parameter entirely when calling Analytics Service endpoints — it does NOT pass an empty array. Passing an empty array would return zero results.

**Service-to-service auth:** All calls to Analytics Service — both synchronous (dashboard requests) and asynchronous (scheduled report jobs) — use a dedicated Identity Service API key stored in the `ANALYTICS_API_KEY` environment variable. This key is created via the Identity Service API key management with permissions scoped to analytics read. The Reporting Service includes it as `Authorization: Bearer ak_<key>`. The Analytics Service validates `ak_`-prefixed tokens via `POST /identity/api-keys/validate` (VPC-internal). See Section 8 for the required Analytics Service spec amendment.

### 3.2 Computed KPIs

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

### 3.3 Caching

An in-process LRU cache (500 entries, 5-min TTL) wraps `metrics-calculator.ts` in `metrics-cache.ts`.

- **Cache key:** `sha256(metric_family + '|' + period + '|' + sorted(location_ids).join(','))`
- **Cache miss:** triggers all parallel Analytics Service calls; result stored before returning
- **Cache scope:** per ECS instance — no shared state across tasks. Acceptable given the 5-min TTL and typical single-session dashboard load patterns
- **No manual invalidation:** TTL expiry is the only eviction mechanism

---

## 4. API

All routes served via the CRM API Gateway. JWT required on every endpoint via `@ortho/auth-middleware`.

**Location access control** (enforced by Reporting Service, not Analytics Service):
- `call_center_agent`: own location only
- `call_center_manager`: assigned locations only
- `marketing_staff`, `marketing_manager`: all locations

### 4.1 Dashboard & Metrics

```
GET /reporting/dashboard
    ?period=YYYY-MM | YYYY-MM-DD/YYYY-MM-DD
    &location_id[]=...
    &granularity=daily|monthly|total
    → { period, granularity, kpis: {...}, missing_revenue_config: [...] }

GET /reporting/metrics/channel-performance
    → leads, funnel rates, and cost metrics broken down by channel

GET /reporting/metrics/location-comparison
    → per-location KPIs + network_average object (always computed across ALL locations,
      regardless of caller's location filter — used for benchmark comparison)

GET /reporting/metrics/coordinator-performance
    ?coordinator_id=...   (optional)
    → per-coordinator: stage_transitions, exams_booked, conversions, avg_response_time_seconds

GET /reporting/metrics/campaign-analytics
    → sent, delivered, opened, clicked, conversion rate per email campaign
```

All metric endpoints accept `period`, `location_id[]`, `granularity`. Metric-specific additional filters (e.g. `channel`, `coordinator_id`) are passed through to Analytics Service after access-control filtering.

**Coordinator performance access control:** A `call_center_agent` caller's `coordinator_id` filter is overwritten with their own JWT `sub` — agents may only view their own metrics. `call_center_manager` and marketing roles may pass any `coordinator_id` within their permitted locations.

### 4.2 Report Configs

```
GET    /reporting/report-configs              → list saved configs
                                               ?all=true  (marketing_manager+ only)
                                                          returns all configs system-wide
POST   /reporting/report-configs              → create config
PUT    /reporting/report-configs/:id          → update (own config, or marketing_manager+)
DELETE /reporting/report-configs/:id          → delete (cascades to schedules)
                                               marketing_manager+ may delete any config
POST   /reporting/report-configs/:id/generate → on-demand generate
                                               ?format=pdf|csv (default: pdf)
                                               → { run_id }
```

**Role-based access:**
- All roles may create report configs. Location-scoped roles (`call_center_agent`, `call_center_manager`) may only create configs whose `parameters.location_ids` are within their permitted locations.
- `GET /reporting/report-configs` returns only the caller's own configs unless `all=true` is passed by a `marketing_manager+`.
- `marketing_manager+` may update and delete any config regardless of `created_by`.

**On-demand generate polling:** The endpoint enqueues the job and returns `{ run_id }` immediately. The caller polls `GET /reporting/runs/:id` at a recommended interval of 2s. If the run has not reached `done` or `failed` within 5 minutes, the frontend should surface a timeout message. Alternatively, the run completion can be pushed via Notification Service — the `generate-report` job calls `POST /notifications/publish` with the requesting user's channel on completion, eliminating the need to poll.

### 4.3 Schedules

```
GET    /reporting/schedules                   → list schedules for caller's configs
POST   /reporting/schedules                   → create schedule → registers BullMQ repeatable job
PUT    /reporting/schedules/:id               → update → replaces BullMQ job
DELETE /reporting/schedules/:id               → delete → removes BullMQ job
```

### 4.4 Report Runs

```
GET   /reporting/runs                          → run history; filterable by ?config_id=
GET   /reporting/runs/:id                      → single run status
GET   /reporting/runs/:id/download             → 302 redirect to fresh Media Service presigned URL
POST  /reporting/runs/:id/retry                → re-enqueue a failed run as a new one-off job
                                                requires run.status = 'failed'
                                                → { run_id }  (new run_id)
```

`/download` calls `GET /media/internal/:file_id/signed-url` on each request — never stores presigned URLs, respecting the 15-min TTL. The `/download` endpoint requires a valid CRM user JWT; all report recipients must be CRM users (v1 scope). `/retry` creates a new `report_run` row and enqueues a fresh `generate-report` job — it does not mutate the failed run row.

### 4.5 Configuration

```
GET  /reporting/config/revenue                → list location_revenue_config rows
                                               scoped to caller's permitted locations
                                               (marketing_manager+ sees all)
PUT  /reporting/config/revenue/:location_id   → set avg_contract_value
                                               requires marketing_manager role
```

`location_id` on the PUT is treated as an opaque string — the Reporting Service does not validate whether it corresponds to a real location. Invalid location IDs produce no harm (a revenue config for a non-existent location is never returned in metric queries). Location validation, if required, is the CRM API Gateway's responsibility.

---

## 5. Report Generation Pipeline

On-demand and scheduled report runs share the same pipeline, implemented in `report-renderer.ts`.

### 5.1 Steps

```
1. Load report_config + parameters from DB
2. Resolve period (e.g. 'last_month' → concrete YYYY-MM-DD/YYYY-MM-DD range)
3. Fetch metrics via metrics-cache.ts (5-min cache applies)
4. Generate document:
   ├── PDF → render Handlebars template with metrics data
   │         → Puppeteer headless Chromium → Buffer (see Section 5.2 for crash handling)
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
   -- Link points to /reporting/runs/:id/download (the 302 endpoint) NOT to a presigned URL.
   -- Presigned URLs expire in 15 minutes; the /download endpoint fetches a fresh one on each click.
   -- All recipients must be CRM users (their JWT is required to access /download).
8. If recipient_emails and run is for on-demand request:
   POST /notifications/publish { channel: 'user:{triggered_by}', ... }  (notify requesting user)
9. On any failure: update report_run: status=failed, error_message
```

### 5.2 HTML Templates and Puppeteer Crash Handling

Five Handlebars templates in `templates/` — one per report type. Bundled into the Docker image at build time. Puppeteer launches headless Chromium, renders the compiled template with injected metrics data, and exports PDF. No runtime template fetch.

**Puppeteer safety rules (enforced in `pdf-generator.ts`):**
- A new browser instance is launched per job — no shared browser across concurrent jobs. One Chromium crash cannot affect other in-flight generations.
- `page.setDefaultTimeout(30_000)` set immediately after page creation — prevents indefinite hangs if Chromium stalls.
- Browser is closed in a `finally` block regardless of success or failure — prevents zombie Chromium processes.
- The ECS task memory allocation must account for Chromium's ~150MB baseline footprint in addition to Node.js heap. Recommended minimum: 512MB per task.

### 5.3 Media Service Integration

Uses the internal service auth token (`INTERNAL_API_SECRET` header). `uploaded_by` set to `SERVICE_CALLER_ID` sentinel UUID per Media Service spec. Files stored in the **private bucket** (presigned GET URLs, 15-min TTL) — report content is business-sensitive.

### 5.4 BullMQ Job: `generate-report`

```typescript
interface GenerateReportJob {
  report_config_id: string
  report_run_id: string        // pre-created in DB with status=pending
  format: 'pdf' | 'csv'
  recipient_emails?: string[]
  report_schedule_id?: string  // set for scheduled runs, null for on-demand
}
```

Queue: `reporting-jobs`. Retries: 2 attempts with exponential backoff. On final failure, `report_run` row updated to `status=failed`.

The Fastify HTTP server and BullMQ worker run in the same ECS task process — consistent with other services in the codebase.

---

## 6. Scheduled Reports

### 6.1 Schedule Manager

`schedule-manager.ts` maintains a BullMQ repeatable job for every active `report_schedule` row. Job ID is deterministic: `report-schedule:{schedule_id}`.

**Cron expression derivation:**
```
daily   → 0 {hour_utc} * * *
weekly  → 0 {hour_utc} * * {day_of_week}
monthly → 0 {hour_utc} {day_of_month} * *
```

**Lifecycle:**
- `POST /reporting/schedules` → insert DB row → `queue.add(jobId, payload, { repeat: { cron } })`
- `PUT /reporting/schedules/:id` → update DB row → remove old repeatable + add new (BullMQ has no in-place update for repeatable jobs)
- `DELETE /reporting/schedules/:id` → set `active=false` in DB → `queue.removeRepeatable(jobId)`
- `PUT /reporting/schedules/:id` with `{ active: false }` → same BullMQ removal; DB row retained for history

**Startup reconciliation (Redis flush recovery):** On service startup, `schedule-manager.ts` runs a reconciliation pass:
1. Query all `active = true` rows from `report_schedules`
2. Fetch the list of registered repeatable jobs from BullMQ via `queue.getRepeatableJobs()`
3. For any schedule row whose `jobId` is absent from the BullMQ list, re-register the repeatable job

This recovers silently lost schedules after Redis flushes, restarts, or failovers. It is a read-then-conditional-write operation — idempotent and safe to run on every deploy.

### 6.2 Scheduled Job Handler

When a repeatable job fires:
```
1. Load report_schedule + report_config from DB
2. Check schedule.active — if false, acknowledge and skip (safety net for race conditions)
3. Create report_run row (status=pending, triggered_by='scheduler')
4. Enqueue one-off generate-report job with run_id
```

The repeatable job itself is lightweight. The actual PDF/CSV work runs in its own one-off job with independent retry semantics.

---

## 7. Cross-Service Dependencies

| Dependency | Type | Notes |
|---|---|---|
| Analytics Service | REST consumer | All metric endpoint families + generic DSL. Authenticated via `ANALYTICS_API_KEY` Identity Service API key (not user JWT) — applies to both synchronous and scheduled calls. Reporting Service fans out parallel calls per dashboard request. |
| Media Service | REST (internal) | `POST /media/internal/store` to upload reports. `GET /media/internal/:file_id/signed-url` on each `/download` request. Uses `INTERNAL_API_SECRET` header. |
| Email Service | REST | `POST /emails/send` for report delivery. Plain HTML body with `/reporting/runs/:id/download` link — no presigned URL, no template_id. |
| Notification Service | REST | `POST /notifications/publish` to notify requesting user when on-demand report completes. |
| Identity Service | JWT validation + API key | JWT required on all inbound endpoints. `ANALYTICS_API_KEY` created via Identity Service for outbound Analytics Service calls. |
| BullMQ / Redis | Job queue | `reporting-jobs` queue for report generation. Repeatable jobs for scheduled delivery. Startup reconciliation on Redis flush. |

---

## 8. Pending Amendments

### 8.1 Pipeline Engine Spec

The `lead.stage_changed` event already carries a `triggered_by` field (the user UUID of the staff member who triggered the transition; `null` for automated transitions). No new `coordinator_id` field is needed — the Analytics Service amendment (Section 8.2) reads `triggered_by` as the coordinator dimension.

Add two new fields to the `lead.stage_changed` event payload:

1. `response_time_seconds` — seconds elapsed from `lead.created_at` to this transition; populated **only** when `stage_to = 'contacted'`, `null` otherwise
2. `time_in_stage_seconds` — seconds spent in the previous stage; populated on every transition except the first enrollment into a pipeline

`triggered_by` should also be confirmed present in the `lead.converted` payload so conversions can be attributed to coordinators in `metrics_coordinators_daily`.

### 8.2 Analytics Service Spec

**Add `metrics_coordinators_daily` rollup table:**
```sql
date                       date           NOT NULL
location_id                text           NOT NULL
coordinator_id             text           NOT NULL   -- sourced from triggered_by on lead.stage_changed
stage_transitions          int            NOT NULL DEFAULT 0
exams_booked               int            NOT NULL DEFAULT 0   -- stage_to = 'exam_scheduled'
conversions                int            NOT NULL DEFAULT 0   -- from lead.converted
response_time_count        int            NOT NULL DEFAULT 0   -- count of 'contacted' transitions
avg_response_time_seconds  numeric(10,2)            -- correctly maintained via count column
UNIQUE (date, location_id, coordinator_id)
```

The `avg_response_time_seconds` upsert uses `response_time_count` to maintain a correct incremental mean:
```sql
ON CONFLICT (date, location_id, coordinator_id) DO UPDATE SET
  response_time_count = metrics_coordinators_daily.response_time_count + 1,
  avg_response_time_seconds = (
    COALESCE(metrics_coordinators_daily.avg_response_time_seconds, 0)
      * metrics_coordinators_daily.response_time_count
      + EXCLUDED.avg_response_time_seconds
  ) / (metrics_coordinators_daily.response_time_count + 1)
```
This update only executes when the incoming `lead.stage_changed` event has `stage_to = 'contacted'` and non-null `response_time_seconds`.

**Update `StageChangedHandler`** to extract `triggered_by` (as coordinator_id), `response_time_seconds`, `time_in_stage_seconds` from payload and populate `metrics_coordinators_daily`. Skip coordinator rollup if `triggered_by` is null (automated transitions).

**Update `LeadConvertedHandler`** to extract `triggered_by` from payload and increment `metrics_coordinators_daily.conversions`.

**Add `GET /analytics/metrics/coordinators` endpoint** — same shared `period`/`granularity`/`location_id` params; additional filter: `coordinator_id`.

### 8.3 Analytics Service Spec (Auth Amendment)

The Analytics Service currently accepts only Identity Service JWTs. Add support for Identity Service API key tokens (`ak_`-prefixed) in the Analytics Service's `@ortho/auth-middleware` configuration. When the `Authorization: Bearer` value begins with `ak_`, validate via `POST /identity/api-keys/validate` (VPC-internal) instead of JWT signature verification. This enables service-to-service calls from Reporting Service (and potentially other consumers) without requiring a user session.

### 8.4 Arch Doc

1. Remove Reporting Service from `lead.converted` EventBridge subscribers — Reporting Service does not subscribe to any events.
2. Add `GET /reporting/*` → Analytics Service to the REST call table in Section 3.2.

---

## 9. File Structure

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
│   │   └── config.ts
│   ├── services/
│   │   ├── analytics-client.ts       # typed HTTP client for Analytics Service
│   │   ├── metrics-calculator.ts     # fans out Analytics calls + computes KPIs
│   │   ├── metrics-cache.ts          # 5-min LRU wrapping metrics-calculator
│   │   ├── report-renderer.ts        # orchestrates: calc → generate → upload → email
│   │   ├── pdf-generator.ts          # Puppeteer HTML→PDF Buffer
│   │   ├── csv-generator.ts          # fast-csv serialization per report type
│   │   ├── email-sender.ts           # calls Email Service with download link
│   │   └── schedule-manager.ts       # BullMQ repeatable job CRUD
│   ├── repositories/
│   │   ├── report-configs.ts
│   │   ├── schedules.ts
│   │   ├── runs.ts
│   │   └── revenue-config.ts
│   ├── jobs/
│   │   └── generate-report.ts        # BullMQ job handler → calls report-renderer
│   └── index.ts
├── templates/
│   ├── weekly-summary.hbs
│   ├── monthly-executive.hbs
│   ├── channel-deep-dive.hbs
│   ├── coordinator-productivity.hbs
│   └── lead-source.hbs
├── migrations/
├── test/
├── Dockerfile
├── package.json
└── tsconfig.json
```
