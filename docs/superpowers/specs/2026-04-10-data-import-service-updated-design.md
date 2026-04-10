# Data Import Service — Updated Design Spec

**Date:** 2026-04-10
**Status:** Approved
**Supersedes:** `2026-03-25-data-import-service-design.md`
**Scope:** Product-layer Data Import Service — Ortho2 CSV parsing, column auto-mapping, 5-tier match logic, validation preview, async job processing, import log, 2-hour bulk undo. Incorporates all implementation decisions from the Q&A session (`tasks/prd-questions-data-import-service.md`).

---

## 1. Overview

The Data Import Service is a **product-layer service** (`apps/crm/import`) that bridges Ortho2 (the practice's EHR) and the CRM via manual CSV export and import. It is a temporary bridge — when the EHR integration is built, this service becomes unnecessary.

**Core responsibilities:**
- Accept Ortho2 CSV uploads from coordinators and marketing managers
- Parse and auto-map CSV columns to CRM fields using known Ortho2 header names
- Run 5-tier match logic against Lead Service to find the corresponding CRM lead for each CSV row
- Present a validation preview before any CRM state is modified
- Execute pipeline transitions and conversions via Pipeline Engine
- Maintain a full import log with 2-hour bulk undo
- Persist column mappings globally per import type to eliminate re-mapping friction for recurring imports

**Out of scope:**
- Sending messages or triggering automation directly — downstream effects happen via Pipeline Engine events reacted to by Automation Engine
- PHI or clinical data — only name, phone, email, DOB, appointment date are used for matching; no clinical records stored
- EHR real-time integration — this service is explicitly a temporary CSV bridge

---

## 2. Architecture

```
CRM API Gateway (coordinator/manager upload request)
        │
        ▼ REST + JWT
┌─────────────────────────────────────────────────────┐
│              Data Import Service                     │
│            apps/crm/import                           │
│                                                      │
│  routes/          services/           workers/       │
│  imports     →  import.service    →  import-job      │
│  rows        →  match.service        (BullMQ,        │
│  mappings    →  undo.service          3 phases)      │
│  actions                                             │
│                                                      │
│  repositories/                                       │
│  import.repo                                         │
│  import-row.repo                                     │
│  column-mapping.repo                                 │
└───────────────┬─────────────────────────────────────┘
                │
     ┌──────────┼──────────┐
     ▼          ▼          ▼
  S3 (CSV)  Pipeline    Lead
  storage   Engine      Service
            (direct,    (direct,
            svc key)    svc key)
```

**Key properties:**
- No EventBridge subscriptions — Data Import Service is REST-only inbound
- No EventBridge events published — all downstream effects driven by Pipeline Engine's existing `lead.stage_changed` and `lead.converted` events
- Direct service calls to Pipeline Engine and Lead Service using `IMPORT_SERVICE_API_KEY` (service-to-service credential, not proxied through CRM API Gateway)
- `triggered_by` passthrough — the uploading coordinator's user UUID (`req.user.sub` from the decoded JWT forwarded by the Gateway) is passed as `triggered_by` on every Pipeline Engine call; `override: true` is always set (imports are human-initiated; the coordinator is accountable)
- File storage — CSV files stored on S3 under prefix `imports/{import_id}/raw.csv` (direct S3 access, not via Media Service)

**Golden rule compliance:** Data Import Service never reads from `crm_pipeline` or `crm_leads` schemas directly. All lead data is accessed via Lead Service API; all pipeline state changes go through Pipeline Engine API.

### 2.1 Service Entry Point (`src/index.ts`)

Single process — the HTTP server and BullMQ worker share one ECS task. `src/index.ts` wires:
1. `createLogger('import')` from `@ortho/logger`
2. Knex instance from `@ortho/db` (connection pool, `searchPath: 'crm_imports'`)
3. Fastify 5 app with `@ortho/auth-middleware` (`authPlugin`)
4. Route plugins registered in order (see §5 for registration order)
5. BullMQ worker started (`src/workers/import-job.ts`, concurrency: 2)
6. BullMQ `failed` event listener wired to Datadog APM for uncaught job errors
7. `SIGTERM` handler: drain BullMQ worker → close Fastify → close Knex pool → exit

### 2.2 Environment Variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `REDIS_URL` | Yes | BullMQ queue backend |
| `AWS_REGION` | Yes | AWS region (e.g. `us-east-1`) |
| `S3_BUCKET` | Yes | Dedicated imports bucket (not the Media Service bucket) |
| `PIPELINE_ENGINE_URL` | Yes | Base URL for Pipeline Engine HTTP client |
| `LEAD_SERVICE_URL` | Yes | Base URL for Lead Service HTTP client |
| `IMPORT_SERVICE_API_KEY` | Yes | `ak_`-prefixed service key; passed as `Authorization: Bearer` on all outbound calls |
| `IDENTITY_JWKS_URL` | Yes | JWKS endpoint for JWT verification |
| `PORT` | Yes | Fastify listen port |
| `LOG_LEVEL` | No | Default: `info` |

AWS credentials are obtained from the ECS task IAM role automatically — no explicit key variables needed in the task definition.

---

## 3. Auth & RBAC

All endpoints require a valid JWT via `@ortho/auth-middleware`. Two roles permitted:
- `call_center_manager` — own location only
- `marketing_manager+` — all locations

Use `requirePermission` + `requireLocation()` preHandlers from `@ortho/auth-middleware`. The CRM API Gateway enforces location scoping before forwarding; the service double-checks per the auth-middleware ADR pattern.

The service-to-service API key (`IMPORT_SERVICE_API_KEY`) is an `ak_`-prefixed key created in the Identity Service. It is passed as `Authorization: Bearer <key>` in all outbound HTTP requests to Pipeline Engine and Lead Service. Those services validate it via `POST /identity/api-keys/validate` on the Identity Service (same pattern as `ANALYTICS_API_KEY` used by the Reporting Service).

---

## 4. Import Types

| Import Type | Ortho2 Report | Frequency | CRM Actions |
|---|---|---|---|
| `active_patients` | Patients with status "Active" or "In Treatment" | Weekly (Monday morning) | Transition to `contract_signed` (override) → `/convert` to In Treatment |
| `completed_patients` | Patients with status "Debanded" or "Completed" | Weekly (Monday morning) | Transition to `treatment_complete` (override) → `/convert` to In Retention |
| `scheduled_appointments` | Upcoming appointment list | Daily (morning) | Transition to `exam_scheduled` (override) + create appointment record in Lead Service |
| `no_shows` | Appointments with no-show status | Daily | Transition `exam_scheduled → contacted` (override, reason: `no_show`) |

### 4.1 active_patients execution

For each matched row:
1. `GET /pipeline/memberships?lead_id={id}&pipeline=new_patient&status=active` (Pipeline Engine) — fetch the lead's active New Patient membership
2. If no active membership returned: mark row `failed` with `error_message: "no_active_membership"`, continue to next row
3. Write `before_snapshot` with `type: "conversion"`, `pre_import_membership_id`, `pre_import_pipeline: "new_patient"`, `pre_import_stage: <membership.stage>`, `post_import_membership_id: null` → set row `status = executing` (single atomic DB update — see §7.2)
4. If `membership.stage == "contract_signed"`, skip step 5 and go directly to step 6
5. `POST /pipeline/memberships/:membership_id/transition` — `{ stage: "contract_signed", override: true, triggered_by, reason: "import" }`
6. `POST /pipeline/memberships/:membership_id/convert` — `{ to_pipeline: "in_treatment", to_stage: "new_patient", triggered_by, reason: "converted", channel: "import" }`
7. Write `post_import_membership_id` (from the `201` response body's `id` field — the newly created In Treatment membership) to snapshot → set row `status = executed`

### 4.2 completed_patients execution

For each matched row:
1. `GET /pipeline/memberships?lead_id={id}&pipeline=in_treatment&status=active` — fetch the lead's active In Treatment membership
2. If no active membership returned: mark row `failed` with `error_message: "no_active_membership"`, continue
3. Write `before_snapshot` with `type: "conversion"`, `pre_import_membership_id`, `pre_import_pipeline: "in_treatment"`, `pre_import_stage: <membership.stage>`, `post_import_membership_id: null` → set row `status = executing`
4. If `membership.stage == "treatment_complete"`, skip step 5 and go directly to step 6
5. `POST /pipeline/memberships/:membership_id/transition` — `{ stage: "treatment_complete", override: true, triggered_by, reason: "import" }`
6. `POST /pipeline/memberships/:membership_id/convert` — `{ to_pipeline: "in_retention", to_stage: "active_retention", triggered_by, reason: "converted", channel: "import" }`
7. Write `post_import_membership_id` (the newly created In Retention membership ID) → set row `status = executed`

### 4.3 scheduled_appointments execution

For each matched row:
1. `GET /pipeline/memberships?lead_id={id}&pipeline=new_patient&status=active` — fetch active New Patient membership
2. If no active membership: mark row `failed` with `error_message: "no_active_membership"`, continue
3. Write `before_snapshot` with `type: "transition"`, `membership_id`, `pipeline: "new_patient"`, `stage: <membership.stage>`, `appointment_id: null` → set row `status = executing`
4. If `membership.stage == "exam_scheduled"`, skip step 5 — avoids emitting duplicate `lead.stage_changed` and re-triggering the appointment confirmation sequence
5. `POST /pipeline/memberships/:membership_id/transition` — `{ stage: "exam_scheduled", override: true, triggered_by, reason: "import" }`
6. `POST /leads/:id/appointments` on Lead Service — `{ appointment_type: "exam", scheduled_at, status: "scheduled", created_by: triggered_by }`
7. Write `appointment_id` into snapshot → set row `status = executed`

### 4.4 no_shows execution

For each matched row:
1. `GET /pipeline/memberships?lead_id={id}&pipeline=new_patient&status=active` — fetch active New Patient membership
2. If no active membership: mark row `failed` with `error_message: "no_active_membership"`, continue
3. If `membership.stage != "exam_scheduled"`: mark row `failed` with `error_message: "unexpected_stage"`, continue
4. Write `before_snapshot` with `type: "transition"`, `membership_id`, `pipeline: "new_patient"`, `stage: "exam_scheduled"`, `appointment_id: null` → set row `status = executing`
5. `POST /pipeline/memberships/:membership_id/transition` — `{ stage: "contacted", override: true, triggered_by, reason: "no_show" }`
6. Set row `status = executed`

No appointment record update — appointment ID is not available in Ortho2 no-show exports. The `lead.stage_changed` event (reason: `no_show`) is sufficient for Automation Engine to trigger the re-engagement sequence.

---

## 5. Database Schema — `crm_imports`

### `imports`

One row per import job. Never deleted — serves as the full import log.

```sql
id               uuid        PRIMARY KEY DEFAULT gen_random_uuid()
location_id      uuid        NOT NULL
import_type      varchar     NOT NULL
                 CHECK (import_type IN (
                   'active_patients', 'completed_patients',
                   'scheduled_appointments', 'no_shows'))
status           varchar     NOT NULL DEFAULT 'uploading'
                 CHECK (status IN (
                   'uploading', 'parsing', 'preview_ready',
                   'executing', 'completed', 'failed',
                   'undoing', 'undone', 'cancelled'))
uploaded_by      uuid        NOT NULL
file_name        varchar     NOT NULL
file_key         varchar     NOT NULL
column_mapping   jsonb       NULL       -- coordinator's confirmed mapping (set at confirm time)
detected_headers text[]      NULL       -- raw CSV header row, set after parse
row_count        int         NULL
matched_count    int         NULL
unmatched_count  int         NULL
ambiguous_count  int         NULL
executed_count   int         NULL
failed_count     int         NULL
error_message    varchar     NULL       -- job-level failure message
completed_at     timestamptz NULL
undo_deadline    timestamptz NULL       -- computed in Postgres: completed_at + interval '2 hours'
undone_at        timestamptz NULL
created_at       timestamptz NOT NULL DEFAULT now()
updated_at       timestamptz NOT NULL DEFAULT now()
```

**Indexes:**
```sql
INDEX (location_id, created_at DESC)
INDEX (uploaded_by)
INDEX (status)
```

### `import_rows`

One row per CSV row. Stores match result, execution status, before-snapshot for undo.

```sql
id               uuid        PRIMARY KEY DEFAULT gen_random_uuid()
import_id        uuid        NOT NULL REFERENCES imports(id)
row_number       int         NOT NULL
raw_data         jsonb       NOT NULL
matched_lead_id  uuid        NULL
match_tier       smallint    NULL       -- 1–5; NULL if unmatched
candidate_ids    uuid[]      NULL       -- populated when ambiguous
status           varchar     NOT NULL DEFAULT 'pending'
                 CHECK (status IN (
                   'pending', 'unmatched', 'ambiguous', 'matched',
                   'executing', 'executed', 'failed', 'undone'))
before_snapshot  jsonb       NULL
error_message    varchar     NULL
created_at       timestamptz NOT NULL DEFAULT now()
updated_at       timestamptz NOT NULL DEFAULT now()

UNIQUE (import_id, row_number)
INDEX (import_id)
INDEX (import_id, status)
```

### `column_mappings`

Global per import type. One row per type — upserted on each confirmed import.

```sql
import_type  varchar     PRIMARY KEY
             CHECK (import_type IN (
               'active_patients', 'completed_patients',
               'scheduled_appointments', 'no_shows'))
mapping      jsonb       NOT NULL
updated_at   timestamptz NOT NULL DEFAULT now()
updated_by   uuid        NOT NULL
```

---

## 6. API

All endpoints require a valid JWT via `@ortho/auth-middleware`. RBAC: `call_center_manager` (own location only) and `marketing_manager+` (all locations). The CRM API Gateway enforces location scoping before forwarding; the service double-checks.

Request bodies are validated with TypeBox schemas (`@sinclair/typebox 0.34`) passed to Fastify's `schema: { body: T }` option — compiled to AJV validators at startup.

**Route registration order in `src/index.ts`:**
1. `mappings.ts` — `GET /imports/column-mappings/:type` (registered **first** to prevent Fastify matching `"column-mappings"` as `:id`)
2. `imports.ts` — `POST /imports`, `GET /imports`, `GET /imports/:id` (`:id` constrained to UUID format via TypeBox schema)
3. `rows.ts` — `GET /imports/:id/rows`
4. `actions.ts` — `POST /imports/:id/confirm|cancel|undo`

Belt-and-suspenders protection: both registration order AND UUID format constraint on `:id` are applied.

### Import lifecycle

| Method | Path | Notes |
|---|---|---|
| `POST /imports` | Start import | Multipart form: `file`, `import_type`, `location_id`. `import_id` generated with `crypto.randomUUID()` before upload. Streams CSV directly to S3 via `@fastify/multipart` + AWS SDK v3 `@aws-sdk/lib-storage` `Upload` helper (no buffering, no temp file). S3 key: `imports/{import_id}/raw.csv`. Creates `imports` row, enqueues `parse_match` job. Returns `201` with import object. |
| `GET /imports/:id` | Poll status | Returns full import row including `detected_headers` (available after parse). Frontend polls until `status = preview_ready` or `failed`. |
| `GET /imports/:id/rows` | Preview rows | Paginated. Query params: `status` filter (`matched\|unmatched\|ambiguous\|failed`), `limit`, `cursor` (row_number). Response: `{ data: rows[], nextCursor: lastRowNumber \| null }`. |
| `POST /imports/:id/confirm` | Execute | Body: `{ column_mapping }`. Validates `status = preview_ready`. (1) Upserts `column_mappings` table. (2) Saves confirmed mapping as `imports.column_mapping`. (3) Enqueues `execute` job. Returns `202`. `409` if wrong status. Does NOT re-run match logic. |
| `POST /imports/:id/cancel` | Cancel | Valid only when `status = preview_ready`. Sets `status = cancelled`. No pipeline changes have been made. |
| `POST /imports/:id/undo` | Undo | Atomic: `UPDATE imports SET status = 'undoing' WHERE id = $1 AND status = 'completed' AND undo_deadline > now()`. If `rowCount === 0`: follow-up `SELECT status, undo_deadline WHERE id = $1` — `undo_deadline <= now()` → `422 { "error": "undo_window_expired" }`; `status != 'completed'` → `409`; not found → `404`. Enqueues `undo` job on success. Returns `202`. |

### Import log

| Method | Path | Notes |
|---|---|---|
| `GET /imports` | List past imports | Filter: `location_id`, `import_type`, `status`. Paginated cursor (`created_at DESC`). Location-scoped per JWT. |

### Column mappings

| Method | Path | Notes |
|---|---|---|
| `GET /imports/column-mappings/:type` | Get saved mapping | Returns `{ import_type, mapping, updated_at, updated_by }`. `404` if no mapping saved yet. |

**Error shape** (all endpoints): `{ "error": "<message>" }`

---

## 7. Job Processing

Single BullMQ queue: `import-jobs`. Single job type: `import-job`. Payload: `{ import_id, phase }` where `phase: 'parse_match' | 'execute' | 'undo'`. The worker in `src/workers/import-job.ts` switches on `phase`.

**BullMQ job configuration:**
- `attempts: 1` — no automatic retry (partial pipeline state makes blind retry dangerous)
- `removeOnComplete: true` — import state is tracked in Postgres, not BullMQ
- `removeOnFail: false` — keep failed job payloads for Datadog/BullMQ dashboard inspection
- Concurrency: 2 workers per ECS instance

**Job-level failure handling:** The worker wraps the entire phase handler in `try/catch`. On catch: `UPDATE imports SET status = 'failed', error_message = err.message` → re-throw. BullMQ marks the job failed. The BullMQ `failed` event listener (wired at startup) surfaces the error to Datadog APM. Since `attempts: 1`, no retry occurs.

### Phase 1: `parse_match`

1. Set `imports.status = 'parsing'`
2. Read CSV from S3 as a readable stream
3. Pipe through `csv-parse` with `{ columns: true, skip_empty_lines: true }` — produces `Record<string, string>[]`; uses the CSV header row as object keys; handles quoted fields, BOM, CRLF
4. Load saved global `column_mappings` for `import_type`; merge with auto-detected Ortho2 headers (auto-detection using `ortho2-headers.ts` runs first; saved mapping overrides matching keys)
5. Extract `detected_headers` (raw CSV header row) for storage on the `imports` record
6. **Batch prefetch:**
   - Extract all mobile phone numbers from parsed rows; normalize each to E.164 using `libphonenumber-js`
   - Extract all email addresses from parsed rows; normalize to lowercase
   - `GET /leads?phones[]={...}&location_id={id}` → build `Map<e164phone, Lead[]>`
   - `GET /leads?emails[]={...}&location_id={id}` → build `Map<email, Lead[]>`
   - Map values are arrays to correctly capture the multi-match ambiguous case
7. For each row: run 5-tier match logic (§8)
8. Batch-insert one `import_rows` row per CSV row
9. Update `imports`: `row_count`, `matched_count`, `unmatched_count`, `ambiguous_count`, `detected_headers`, `status = 'preview_ready'`

On job-level failure: set `imports.status = 'failed'`, `error_message`. Coordinator must re-upload.

### Phase 2: `execute`

Process `import_rows WHERE import_id = $1 AND status = 'matched'` in `row_number ASC` order.

Use a `for` loop (not `Promise.all`) — `await` each row's Pipeline Engine calls before moving to the next. Ensures predictable undo ordering and avoids Pipeline Engine contention on same lead if CSV has duplicates.

**Crash recovery:** On job restart, query rows with `status NOT IN ('executed', 'failed')`. Rows with `status = 'executing'` (crashed mid-row) are logged to Datadog and skipped — not re-executed, because the Pipeline Engine call may have partially succeeded. Coordinator handles these manually.

For each row (per import type detail in §4):
1. `GET /pipeline/memberships?lead_id={id}&pipeline={expected}&status=active`
2. If missing or wrong stage: mark row `failed`, continue
3. **Atomic DB update:** `UPDATE import_rows SET before_snapshot = $1, status = 'executing' WHERE id = $2` — single statement, both fields set before any external call
4. Execute Pipeline Engine (and Lead Service) calls
5. On success: write `post_import_membership_id` if conversion; set row `status = 'executed'`
6. On per-row failure: `PipelineEngineError` thrown by HTTP client is caught in the loop; set row `status = 'failed'`, `error_message = 'pipeline_engine_error: <status>'`; continue to next row

After all rows: `UPDATE imports SET executed_count = $1, failed_count = $2, status = 'completed', completed_at = now(), undo_deadline = now() + interval '2 hours'` — `undo_deadline` computed in Postgres.

### Phase 3: `undo`

Process `import_rows WHERE import_id = $1 AND status = 'executed'` in **reverse** `row_number` order.

For each row:
1. Read `before_snapshot`
2. Execute reverse operations (§9)
3. On success: set row `status = 'undone'`
4. On failure: log to Datadog, write `error_message` to row, row remains `'executed'` — best-effort undo, continue

After all rows: `UPDATE imports SET status = 'undone', undone_at = now()` — regardless of partial row failures.

**Rows stuck in `executing`** (crashed mid-snapshot write) are skipped by undo and logged to Datadog — coordinator handles manually.

---

## 8. Match Logic

All lookups scoped to `location_id` from the import. Tiers run in order; stop at first tier returning exactly one lead.

**Tier 1 — Mobile phone (exact E.164)**
Normalize CSV mobile phone via `libphonenumber-js` (handles US formats: `(555) 123-4567`, `555-123-4567`, `5551234567` → `+15551234567`) → look up in local `Map<phone, Lead[]>` from batch prefetch.
- 1 result → `matched`, `match_tier: 1`
- 2+ results → `ambiguous`, `candidate_ids` populated
- 0 results → Tier 2

**Tier 2 — Email (exact, case-insensitive)**
Lowercase email → look up in local `Map<email, Lead[]>` from batch prefetch.
- 1 result → `matched`, `match_tier: 2`
- 2+ results → `ambiguous`
- 0 results → Tier 3

**Tier 3 — First name + last name + home phone**
`GET /leads?q={first} {last}&location_id={id}` → filter results in-process for exact E.164 home phone match against `leads.phone`. **Cache the name search result in-process for Tier 4 reuse** (scoped to the current row's resolution only — discarded after Tier 4; never shared across rows). Single API call per row for Tiers 3–4 combined.
- 1 result → `matched`, `match_tier: 3`
- 2+ results → `ambiguous`
- 0 results → Tier 4

**Tier 4 — First name + last name + date of birth**
Reuse cached name search result from Tier 3 → filter in-process for exact DOB match against `leads.date_of_birth`. No additional API call.
- 1 result → `matched`, `match_tier: 4`
- 2+ results → `ambiguous`
- 0 results → Tier 5

**Tier 5 — No match**
Row `status = 'unmatched'`. Shown in preview. No CRM action taken.

---

## 9. Undo Mechanism

`before_snapshot` is written to `import_rows` atomically (single UPDATE with `status = 'executing'`) just before Pipeline Engine calls. Two shapes:

### Transition snapshot (scheduled_appointments, no_shows)

```json
{
  "type": "transition",
  "membership_id": "uuid",
  "pipeline": "new_patient",
  "stage": "contacted",
  "appointment_id": "uuid | null"
}
```

**Undo:** `POST /pipeline/memberships/:membership_id/transition` with `{ stage: snapshot.stage, override: true, triggered_by: import.uploaded_by, reason: "import_undo" }`.

Undo transitions use `override: true` and do **not** verify the lead's current stage — undo is applied unconditionally within the 2-hour window. If a coordinator has since advanced the lead manually, the undo forcibly reverts to the pre-import stage.

If `appointment_id` is set (scheduled_appointments only): `DELETE /leads/:lead_id/appointments/:appointment_id` on Lead Service.

### Conversion snapshot (active_patients, completed_patients)

Written in two steps:

**Initial write** (before Pipeline Engine calls):
```json
{
  "type": "conversion",
  "pre_import_membership_id": "uuid",
  "pre_import_pipeline": "new_patient",
  "pre_import_stage": "contacted",
  "post_import_membership_id": null
}
```

**Final write** (after `/convert` succeeds):
```json
{
  "type": "conversion",
  "pre_import_membership_id": "uuid",
  "pre_import_pipeline": "new_patient",
  "pre_import_stage": "contacted",
  "post_import_membership_id": "uuid"
}
```

Rows stuck in `executing` (crashed between the two writes) are skipped by undo and logged to Datadog.

**Undo of a conversion — operation order:**
1. `POST /pipeline/memberships/:post_import_membership_id/close` — closes the newly-created membership, setting `status = 'closed'` and `closed_reason = 'import_undo'`. Body: `{ triggered_by: import.uploaded_by, reason: "import_undo" }`. Returns `200`. `409` if already closed/archived. Publishes no event. `'closed'` (not `'archived'`) is required so the `UNIQUE (lead_id, pipeline) WHERE status = 'active'` constraint allows re-enrollment in step 2.
2. `POST /pipeline/memberships` — re-enrolls lead in `pre_import_pipeline` at `pre_import_stage`. Body: `{ lead_id, location_id: import.location_id, pipeline: snapshot.pre_import_pipeline, stage: snapshot.pre_import_stage, triggered_by, reason: "import_undo" }`. `location_id` is taken from `imports.location_id` (not stored in the snapshot).

The original closed membership from before the import is not restored. A fresh enrollment is created. The complete transition history remains in `pipeline_stage_history` for audit.

---

## 10. Column Mapping

### Auto-detection

Hardcoded in `src/mapping/ortho2-headers.ts`:

| Ortho2 Header | CRM Field |
|---|---|
| `PatFirst` | `first_name` |
| `PatLast` | `last_name` |
| `CellPhone` | `mobile_phone` |
| `HomePhone` | `home_phone` |
| `Email` | `email` |
| `Birthdate` | `date_of_birth` |
| `ApptDate` | `appointment_date` |
| `ApptTime` | `appointment_time` |
| `Status` | `ortho2_status` |

Unrecognized headers surface in the mapping UI as unmapped — coordinator assigns them manually.

### Saved global mapping

On `POST /imports/:id/confirm`, the confirmed `column_mapping` is upserted into `column_mappings`:

```sql
INSERT INTO column_mappings (import_type, mapping, updated_by, updated_at)
VALUES ($1, $2, $3, now())
ON CONFLICT (import_type) DO UPDATE
  SET mapping = $2, updated_by = $3, updated_at = now()
```

On subsequent uploads of the same import type: auto-detection runs first; saved mapping overrides matching entries; remaining unmapped headers shown for manual assignment.

`imports.column_mapping` stores the coordinator's **confirmed** mapping (submitted at `POST /imports/:id/confirm` time). The parse phase runs using the auto-detected + globally-saved mapping, but the coordinator's confirmed mapping supersedes this and is the authoritative record for audit and re-run purposes.

**`POST /imports/:id/confirm` does not re-run match logic.** It executes existing matched `import_rows` as-is. If a coordinator corrects a column mapping at confirm time in a way that would materially affect match quality, they must cancel (`POST /imports/:id/cancel`) and re-upload.

---

## 11. Downstream Effects

Data Import Service publishes no EventBridge events. All downstream effects are driven by Pipeline Engine's existing event publishing:

| Import Action | Pipeline Engine Events | Downstream Effect |
|---|---|---|
| Transition → `contract_signed` + convert to In Treatment | `lead.stage_changed` + `lead.converted` | Automation Engine cancels active nurture sequences; Lead Service updates cache; Analytics logs conversion; Referral Service reacts to `lead.converted` |
| Transition → `treatment_complete` + convert to In Retention | `lead.stage_changed` + `lead.converted` | Automation Engine starts retention sequences; Referral Service creates patient referrer (`referrer.created`) |
| Transition → `exam_scheduled` | `lead.stage_changed` | Automation Engine starts appointment confirmation sequence |
| Transition → `contacted` (no_show) | `lead.stage_changed` (reason: `no_show`) | Automation Engine triggers no-show re-engagement sequence |

---

## 12. HTTP Clients

Located in `src/clients/`. Thin typed wrappers around Node.js 24 native `fetch` — no additional HTTP library dependency.

`src/clients/pipeline-engine.ts` and `src/clients/lead-service.ts`:
- Read base URLs from `PIPELINE_ENGINE_URL` / `LEAD_SERVICE_URL` env vars
- Always set `Authorization: Bearer ${IMPORT_SERVICE_API_KEY}` header
- Throw a typed `PipelineEngineError` / `LeadServiceError` on non-2xx responses, including the HTTP status in the error message
- The worker loop catches these per-row errors, marks the row `failed`, and continues — no per-row retry

---

## 13. Service Layout

```
apps/crm/import/
├── src/
│   ├── routes/
│   │   ├── imports.ts             # POST /imports, GET /imports, GET /imports/:id
│   │   ├── rows.ts                # GET /imports/:id/rows
│   │   ├── actions.ts             # POST /imports/:id/confirm|cancel|undo
│   │   └── mappings.ts            # GET /imports/column-mappings/:type
│   ├── services/
│   │   ├── import.service.ts      # lifecycle orchestration
│   │   ├── match.service.ts       # 5-tier match logic
│   │   └── undo.service.ts        # snapshot read + reverse operations
│   ├── workers/
│   │   └── import-job.ts          # BullMQ worker: parse_match | execute | undo phases
│   ├── clients/
│   │   ├── pipeline-engine.ts     # typed fetch wrapper for Pipeline Engine
│   │   └── lead-service.ts        # typed fetch wrapper for Lead Service
│   ├── mapping/
│   │   └── ortho2-headers.ts      # hardcoded Ortho2 → CRM field map
│   ├── repositories/
│   │   ├── import.repo.ts
│   │   ├── import-row.repo.ts
│   │   └── column-mapping.repo.ts
│   └── index.ts                   # entry point: logger, Knex, Fastify, worker, graceful shutdown
├── migrations/                    # Knex migrations for crm_imports schema; run as pre-deploy step
├── test/
│   ├── unit/
│   └── integration/
├── Dockerfile
├── package.json
└── tsconfig.json
```

**DB access pattern:** `@ortho/db` provides the Knex instance. Repositories use constructor injection — Knex is created once at startup in `src/index.ts` and passed through to services and repositories. `searchPath: 'crm_imports'` — all table names unqualified.

**Migrations:** Run as a pre-deploy step via `@ortho/db`'s `runMigrations(knex)` utility. The service only migrates its own `crm_imports` schema.

**Runtime dependencies:**
- PostgreSQL (shared RDS cluster, `crm_imports` schema)
- Redis (BullMQ job queue)
- AWS S3 (CSV file storage, dedicated bucket)
- Pipeline Engine (direct HTTP, `IMPORT_SERVICE_API_KEY`)
- Lead Service (direct HTTP, `IMPORT_SERVICE_API_KEY`)

**Key npm packages:**
- `@fastify/multipart` — multipart form parsing for CSV uploads
- `@aws-sdk/lib-storage` — `Upload` helper for streaming S3 writes
- `csv-parse` — streaming CSV parsing (`columns: true`, `skip_empty_lines: true`)
- `libphonenumber-js` — E.164 normalization for US phone numbers
- `bullmq` — job queue

---

## 14. Logging & Observability

`createLogger('import')` from `@ortho/logger` (Pino, Datadog-compatible):
- Worker: child logger per job — `log.child({ importId, phase })`
- Route handlers: child logger per request — `log.child({ requestId, locationId })`
- All errors: `log.error({ err }, 'message')` — `err` key triggers Pino's error serializer (stack trace included)
- Stuck `executing` rows on restart: logged at `warn` level with `{ importId, rowId, rowNumber }`
- Per-row undo failures: logged at `error` level with `{ importId, rowId, err }`
- BullMQ `failed` event listener: `log.error({ jobId, importId, phase, err }, 'import job failed')`

---

## 15. Pagination

`GET /imports/:id/rows` uses `row_number` as cursor (natural ordering, maps to original CSV row order).

Query:
```sql
SELECT * FROM import_rows
WHERE import_id = $1
  AND ($cursor::int IS NULL OR row_number > $cursor)
  AND ($status::varchar IS NULL OR status = $status)
ORDER BY row_number ASC
LIMIT $limit
```

Response: `{ data: rows[], nextCursor: lastRowNumber | null }`. `nextCursor` is `null` when `data.length < limit`.

---

## 16. Testing Strategy

### Unit Tests (Vitest)

- `match.service.ts` — all 5 tiers; exact match, ambiguous, no match; batch prefetch map resolution; `libphonenumber-js` normalization edge cases (various US formats)
- `ortho2-headers.ts` — known headers map to correct CRM fields; unknown headers return `undefined`
- `undo.service.ts` — snapshot shape validation; transition undo calls correct Pipeline Engine endpoint; conversion undo calls close first then re-enroll; `appointment_id` present → `DELETE /appointments/:id` called; `appointment_id` null → no delete call
- `import.service.ts` — `undo_deadline` computed in Postgres (not Node.js); status transition guards (confirm on non-`preview_ready` → 409; undo after deadline → 422)

### Integration Tests (Vitest + real Postgres)

Pipeline Engine and Lead Service mocked via HTTP interceptors (`nock` or `msw` Node adapter intercept outbound `fetch` calls to service base URLs). Tests run against a real Postgres instance per `@ortho/testing` package conventions.

- Parse phase — happy path: CSV parsed, rows matched, `status = preview_ready`; `detected_headers` populated
- Parse phase — all rows unmatched: `status = preview_ready`, `matched_count = 0`
- Parse phase — S3 read failure: `status = failed`, `error_message` set
- Confirm — upserts global `column_mapping`; second confirm on same import → `409`
- Execute phase — active_patients: transition + convert called in order; `before_snapshot` written before calls; `post_import_membership_id` written after convert; row `status = executed`
- Execute phase — partial failure: failed row marked `failed`, subsequent rows continue; import `status = completed`
- Execute phase — crash recovery: rows in `executing` status skipped on restart; warning logged
- Undo — transition type: Pipeline Engine transition called with `pre_import_stage`
- Undo — conversion type: close called first, then re-enroll; correct pipeline/stage from snapshot; `location_id` from import record
- Undo — past deadline: `422 undo_window_expired`
- Undo — `executing` rows skipped (warned, not failed)
- no_shows — unexpected stage guard: row marked `failed` if lead not at `exam_scheduled`

### Contract Tests

- Pipeline Engine calls always include `override: true` and non-null `triggered_by` (interceptor asserts request body)
- `channel: "import"` on all `/convert` calls
- `before_snapshot` always written before any Pipeline Engine call — verified by an interceptor whose response handler reads the `import_rows` DB state synchronously before returning the mock response; asserts `before_snapshot IS NOT NULL` and `status = 'executing'` at first Pipeline Engine call

---

## 17. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Single-process service | HTTP + BullMQ worker in one ECS task | Spec §11 layout; simpler deployment, one task definition |
| `attempts: 1` on BullMQ jobs | No auto-retry | Partial pipeline state makes blind retry dangerous |
| `removeOnComplete: true` | BullMQ job cleanup | Import state is durable in Postgres; BullMQ job payload not needed post-completion |
| `csv-parse` | CSV parsing library | Streaming-compatible, handles quoted fields, BOM, CRLF; standard Node.js choice |
| `libphonenumber-js` | Phone normalization | Handles all common US formats; critical for Tier 1 match reliability |
| Native `fetch` for HTTP clients | No axios/undici | Node.js 24 includes `fetch` globally; no extra dependency |
| `@aws-sdk/lib-storage` Upload | S3 streaming | Avoids buffering large CSVs in memory; no temp disk I/O |
| Batch prefetch for Tiers 1–2 | Two bulk `GET /leads` calls before row loop | O(1) per-row resolution; essential for 1000+ row CSV performance |
| In-process Tier 3 cache | Reuse name search for Tier 4 | One API call per row instead of two; cache scoped to current row only |
| `row_number` cursor for pagination | Sequential CSV order | Natural ordering; simpler cursor than UUID; maps to coordinator's mental model of row position |
| `override: true` always | Pass on all Pipeline Engine calls | Imports are human-initiated; coordinator is accountable; leads may be at arbitrary stages in Ortho2 batch exports |
| Direct service calls | Pipeline Engine + Lead Service via `IMPORT_SERVICE_API_KEY` | CRM API Gateway is for external callers; service-to-service uses direct calls per established pattern |
| No events published | Downstream effects via Pipeline Engine events | Pipeline Engine already publishes `lead.stage_changed` / `lead.converted`; adding import-specific events duplicates signal |
| Global column mapping | One saved mapping per import type | All 34 locations use same Ortho2 version; per-location mappings add storage with no practical benefit |
| Sequential execution | `row_number ASC` order | Predictable undo ordering (reverse row_number); avoids Pipeline Engine contention on same lead |
| Partial success | Continue on per-row failure | A bad row shouldn't block 199 good updates; failures visible in row preview |
| Full conversion undo | Close new membership + re-enroll in prior pipeline | Coordinators expect "undo" to mean fully reversible |
| Atomic undo initiation | Single `UPDATE … WHERE status = 'completed' AND undo_deadline > now()` | Prevents TOCTOU race between concurrent undo requests |
| `undo_deadline` in Postgres | `completed_at + interval '2 hours'` computed in SQL | Avoids clock skew between Node.js and DB; single source of truth |

---

## 18. Pending Amendments to Other Specs

1. **Pipeline Engine spec** — Add `POST /pipeline/memberships/:id/close` endpoint. Body: `{ triggered_by, reason: "import_undo" }`. Sets `status = 'closed'` (not `'archived'`) and `closed_reason = 'import_undo'`. Returns `200` membership. `409` if already closed/archived. Publishes no event. Amend two enums: (a) add `"import_undo"` to `pipeline_stage_history.reason` CHECK (current: `manual | timeout | no_show | converted | import`); (b) add `"import_undo"` to `pipeline_memberships.closed_reason` CHECK (current: `converted | archived | manual | import`).

2. **Lead Service spec** — Add `date_of_birth date nullable` column to `leads` table (required for Tier 4 match logic).

3. **Lead Service spec** — Add `DELETE /leads/:id/appointments/:appointment_id` endpoint. Restricted to `IMPORT_SERVICE_API_KEY` callers. Used for appointment undo.

4. **Lead Service spec** — Add bulk lookup query params to `GET /leads`: `phones[]` (array of E.164) and `emails[]` (array of email strings). Returns all matching leads. Used by parse phase batch prefetch.

5. **Arch doc** — Document `IMPORT_SERVICE_API_KEY` as a service-to-service credential (same pattern as `ANALYTICS_API_KEY`). Add Data Import Service to REST call table as consumer of Pipeline Engine and Lead Service.

6. **Automation Engine spec** — Confirm `lead.stage_changed` with `reason: "no_show"` is a supported trigger condition. Document the no-show re-engagement workflow (triggered by `reason == "no_show"` on stage transition to `contacted`) if not already present.
