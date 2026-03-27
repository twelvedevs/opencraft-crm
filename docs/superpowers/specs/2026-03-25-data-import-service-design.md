# Data Import Service — Design Spec

**Date:** 2026-03-25
**Status:** Approved
**Scope:** Product-layer Data Import Service — Ortho2 CSV parsing, column auto-mapping, 5-tier match logic, validation preview, async job processing, import log, 2-hour bulk undo

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
- `triggered_by` passthrough — the uploading coordinator's user UUID (from the Gateway-forwarded JWT) is passed as `triggered_by` on every Pipeline Engine call; `override: true` is always set (imports are human-initiated; the coordinator is accountable)
- File storage — CSV files stored on S3 under prefix `imports/{import_id}/raw.csv` (direct S3 access, not via Media Service)

**Golden rule compliance:** Data Import Service never reads from `crm_pipeline` or `crm_leads` schemas directly. All lead data is accessed via Lead Service API; all pipeline state changes go through Pipeline Engine API.

---

## 3. Import Types

| Import Type | Ortho2 Report | Frequency | CRM Actions |
|---|---|---|---|
| `active_patients` | Patients with status "Active" or "In Treatment" | Weekly (Monday morning) | Transition to `contract_signed` (override) → `/convert` to In Treatment |
| `completed_patients` | Patients with status "Debanded" or "Completed" | Weekly (Monday morning) | Transition to `treatment_complete` (override) → `/convert` to In Retention |
| `scheduled_appointments` | Upcoming appointment list | Daily (morning) | Transition to `exam_scheduled` (override) + create appointment record in Lead Service |
| `no_shows` | Appointments with no-show status | Daily | Transition `exam_scheduled → contacted` (override, reason: `no_show`) |

### 3.1 active_patients execution

For each matched row:
1. `GET /pipeline/memberships?lead_id={id}&pipeline=new_patient&status=active` (Pipeline Engine) — fetch the lead's active New Patient membership
2. If no active membership returned: mark row `failed` with `error_message: "no_active_membership"`, continue to next row
3. Write `before_snapshot` with `type: "conversion"`, `pre_import_membership_id`, `pre_import_pipeline: "new_patient"`, `pre_import_stage: <membership.stage>`, `post_import_membership_id: null` → set row `status = executing`
4. If `membership.stage == "contract_signed"`, skip step 5 and go directly to step 6 (lead is already at the required pre-conversion stage)
5. `POST /pipeline/memberships/:membership_id/transition` — `{ stage: "contract_signed", override: true, triggered_by, reason: "import" }`
6. `POST /pipeline/memberships/:membership_id/convert` — `{ to_pipeline: "in_treatment", to_stage: "new_patient", triggered_by, reason: "converted", channel: "import" }`
7. Write `post_import_membership_id` (from the `201` response body's `id` field — the newly created In Treatment membership) to snapshot → set row `status = executed`

### 3.2 completed_patients execution

For each matched row:
1. `GET /pipeline/memberships?lead_id={id}&pipeline=in_treatment&status=active` (Pipeline Engine) — fetch the lead's active In Treatment membership
2. If no active membership returned: mark row `failed` with `error_message: "no_active_membership"`, continue to next row
3. Write `before_snapshot` with `type: "conversion"`, `pre_import_membership_id`, `pre_import_pipeline: "in_treatment"`, `pre_import_stage: <membership.stage>`, `post_import_membership_id: null` → set row `status = executing`
4. If `membership.stage == "treatment_complete"`, skip step 5 and go directly to step 6
5. `POST /pipeline/memberships/:membership_id/transition` — `{ stage: "treatment_complete", override: true, triggered_by, reason: "import" }`
6. `POST /pipeline/memberships/:membership_id/convert` — `{ to_pipeline: "in_retention", to_stage: "active_retention", triggered_by, reason: "converted", channel: "import" }`
7. Write `post_import_membership_id` (from the `201` response body's `id` field — the newly created In Retention membership) → set row `status = executed`

### 3.3 scheduled_appointments execution

For each matched row:
1. `GET /pipeline/memberships?lead_id={id}&pipeline=new_patient&status=active` (Pipeline Engine) — fetch the lead's active New Patient membership
2. If no active membership returned: mark row `failed` with `error_message: "no_active_membership"`, continue to next row
3. Write `before_snapshot` with `type: "transition"`, `membership_id`, `pipeline: "new_patient"`, `stage: <membership.stage>`, `appointment_id: null` → set row `status = executing`
4. If `membership.stage == "exam_scheduled"`, skip step 5 and go directly to step 6 — avoids emitting a duplicate `lead.stage_changed` event and re-triggering the appointment confirmation sequence
5. `POST /pipeline/memberships/:membership_id/transition` — `{ stage: "exam_scheduled", override: true, triggered_by, reason: "import" }`
6. `POST /leads/:id/appointments` on Lead Service — `{ appointment_type: "exam", scheduled_at, status: "scheduled", created_by: triggered_by }`
7. Write `appointment_id` into snapshot → set row `status = executed`

### 3.4 no_shows execution

For each matched row:
1. `GET /pipeline/memberships?lead_id={id}&pipeline=new_patient&status=active` (Pipeline Engine) — fetch the lead's active New Patient membership
2. If no active membership returned: mark row `failed` with `error_message: "no_active_membership"`, continue to next row
3. If `membership.stage != "exam_scheduled"`: mark row `failed` with `error_message: "unexpected_stage"`, continue to next row
4. Write `before_snapshot` with `type: "transition"`, `membership_id`, `pipeline: "new_patient"`, `stage: "exam_scheduled"`, `appointment_id: null` → set row `status = executing`
5. `POST /pipeline/memberships/:membership_id/transition` — `{ stage: "contacted", override: true, triggered_by, reason: "no_show" }`
6. Set row `status = executed`

No appointment record update — appointment ID is not available in Ortho2 no-show exports. The `lead.stage_changed` event (reason: `no_show`) is sufficient for Automation Engine to trigger the re-engagement sequence.

---

## 4. Database Schema — `crm_imports`

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
column_mapping   jsonb       NULL       -- snapshot of mapping used for this import
detected_headers text[]      NULL       -- CSV header row, set after parse
row_count        int         NULL
matched_count    int         NULL
unmatched_count  int         NULL
ambiguous_count  int         NULL
executed_count   int         NULL
failed_count     int         NULL
error_message    varchar     NULL       -- job-level failure message
completed_at     timestamptz NULL
undo_deadline    timestamptz NULL       -- completed_at + 2 hours; NULL until completed
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

## 5. API

All endpoints require a valid JWT via `@ortho/auth-middleware`. RBAC: `call_center_manager` (own location only) and `marketing_manager+` (all locations). The CRM API Gateway enforces location scoping before forwarding.

### Import lifecycle

| Method | Path | Notes |
|---|---|---|
| `POST /imports` | Start import | Multipart form: `file`, `import_type`, `location_id`. Streams CSV directly to S3 during the request (synchronous write to S3 in the route handler), creates `imports` row, enqueues `parse_match` job. Returns `201` with import object. |
| `GET /imports/:id` | Poll status | Returns full import row including `detected_headers` (available after parse). Frontend polls until `status = preview_ready` or `failed`. |
| `GET /imports/:id/rows` | Preview rows | Paginated. Query params: `status` filter (`matched\|unmatched\|ambiguous\|failed`), `limit`, `cursor`. |
| `POST /imports/:id/confirm` | Execute | Body: `{ column_mapping }`. Validates `status = preview_ready`. Saves mapping globally. Enqueues `execute` job. Returns `202`. `409` if wrong status. |
| `POST /imports/:id/cancel` | Cancel | Valid only when `status = preview_ready`. Sets `status = cancelled`. No pipeline changes have been made. |
| `POST /imports/:id/undo` | Undo | Atomically sets `status = 'undoing'` with `UPDATE imports SET status = 'undoing' WHERE id = $1 AND status = 'completed' AND undo_deadline > now()`. If 0 rows updated, do a follow-up `SELECT status, undo_deadline FROM imports WHERE id = $1` to discriminate: if `undo_deadline <= now()` → `422 { "error": "undo_window_expired" }`; if `status != 'completed'` → `409`; if row not found → `404`. Enqueues `undo` job on success. Returns `202`. |

### Import log

| Method | Path | Notes |
|---|---|---|
| `GET /imports` | List past imports | Filter: `location_id`, `import_type`, `status`. Paginated cursor, `created_at DESC`. Location-scoped per JWT. |

### Column mappings

| Method | Path | Notes |
|---|---|---|
| `GET /imports/column-mappings/:type` | Get saved mapping | Returns `{ import_type, mapping, updated_at, updated_by }`. Used to pre-populate the mapping UI. `404` if no mapping saved yet. |

**Route registration order:** The `GET /imports/column-mappings/:type` route must be registered **before** the `GET /imports/:id` wildcard route to prevent Fastify from matching `"column-mappings"` as an `:id` value.

**Error shape** (all endpoints): `{ "error": "<message>" }`

---

## 6. Job Processing

Single BullMQ job type: `import-job`. Payload: `{ import_id, phase }`.

Job configuration: `attempts: 1` — no automatic retry (partial pipeline state makes blind retry dangerous). Failures surface to Datadog. Concurrency: 2 workers per ECS instance.

### Phase 1: `parse_match`

1. Read CSV from S3
2. Load saved global `column_mappings` for `import_type`; merge with auto-detected Ortho2 headers (auto-detection runs first, saved mapping overrides)
3. Parse all rows into structured objects
4. **Batch prefetch:** extract all mobile phone numbers and emails from the CSV; call `GET /leads?phones[]={...}&location_id={id}` and `GET /leads?emails[]={...}&location_id={id}` to build local `Map<phone, lead[]>` and `Map<email, lead[]>` for O(1) Tier 1–2 resolution (array values correctly capture the multi-match ambiguous case)
5. For each row: run 5-tier match logic (Section 7)
6. Insert one `import_rows` row per CSV row
7. Update `imports`: `row_count`, `matched_count`, `unmatched_count`, `ambiguous_count`, `detected_headers`, `status = preview_ready`

On job-level failure: set `imports.status = failed`, `error_message`. Coordinator must re-upload.

### Phase 2: `execute`

Process `import_rows WHERE status = 'matched'` in `row_number ASC` order (sequential).

For each row (full detail in Section 3 per import type):
1. `GET /pipeline/memberships?lead_id={id}&pipeline={expected}&status=active` (Pipeline Engine) — fetch active membership
2. If missing or wrong stage: mark row `failed`, continue
3. Write `before_snapshot` + set row `status = executing` (atomic DB update)
4. Execute Pipeline Engine (and Lead Service) calls
5. On success: write `post_import_membership_id` if conversion, set row `status = executed`
6. On failure: set row `status = failed`, `error_message`. Continue to next row.

After all rows: update `imports` with `executed_count`, `failed_count`, `status = completed`, `completed_at`, `undo_deadline = completed_at + interval '2 hours'`.

**Crash recovery:** On job restart, skip rows with `status IN ('executed', 'failed')`. Rows stuck in `executing` are logged to Datadog and skipped by undo — coordinator handles manually.

### Phase 3: `undo`

Process `import_rows WHERE status = 'executed'` in **reverse** `row_number` order.

For each row:
1. Read `before_snapshot`
2. Execute reverse operations (Section 8)
3. On success: set row `status = undone`
4. On failure: log to Datadog, record `error_message`, continue (best-effort undo)

After all rows: set `imports.status = undone`, `undone_at = now()`.

---

## 7. Match Logic

All lookups scoped to `location_id` from the import. Tiers run in order; stop at first tier returning exactly one lead.

**Tier 1 — Mobile phone (exact E.164)**
Normalize CSV mobile phone to E.164 → look up in local `Map<phone, lead[]>` from batch prefetch.
- 1 result → `matched`, `match_tier: 1`
- 2+ results → `ambiguous`, `candidate_ids` populated
- 0 results → Tier 2

**Tier 2 — Email (exact, case-insensitive)**
Normalize email → look up in local `Map<email, lead[]>` from batch prefetch.
- 1 result → `matched`, `match_tier: 2`
- 2+ results → `ambiguous`
- 0 results → Tier 3

**Tier 3 — First name + last name + home phone**
`GET /leads?q={first} {last}&location_id={id}` → filter results in-process for exact E.164 home phone match against `leads.phone`. **Cache the name search result in-process for Tier 4 reuse** (scoped to the current row's resolution only — discarded after Tier 4; not shared across rows) — if Tier 3 fails, Tier 4 reuses the same result set without issuing a second API call.
- 1 result → `matched`, `match_tier: 3`
- 2+ results → `ambiguous`
- 0 results → Tier 4

**Tier 4 — First name + last name + date of birth**
Reuse the name search result cached from Tier 3 → filter in-process for exact DOB match against `leads.date_of_birth`. No additional API call.
- 1 result → `matched`, `match_tier: 4`
- 2+ results → `ambiguous`
- 0 results → Tier 5

**Tier 5 — No match**
Row `status = unmatched`. Shown in preview. No CRM action taken. Coordinator notified in import summary.

---

## 8. Undo Mechanism

`before_snapshot` is written to `import_rows` just before Pipeline Engine calls. Two shapes:

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

Undo transitions use `override: true` and do **not** verify the lead's current stage matches the post-import stage — undo is applied unconditionally within the 2-hour window. If a coordinator has since advanced the lead manually, the undo will forcibly revert them to the pre-import stage.

If `appointment_id` is set (scheduled_appointments only): `DELETE /leads/:lead_id/appointments/:appointment_id` on Lead Service.

### Conversion snapshot (active_patients, completed_patients)

Written in two steps (see Section 3.1 / 3.2 for the full execution sequence):

**Initial write** (before Pipeline Engine calls — row set to `executing`):
```json
{
  "type": "conversion",
  "pre_import_membership_id": "uuid",
  "pre_import_pipeline": "new_patient",
  "pre_import_stage": "contacted",
  "post_import_membership_id": null
}
```

**Final write** (after `/convert` succeeds — row set to `executed`):
```json
{
  "type": "conversion",
  "pre_import_membership_id": "uuid",
  "pre_import_pipeline": "new_patient",
  "pre_import_stage": "contacted",
  "post_import_membership_id": "uuid"
}
```

Rows stuck in `executing` (crashed between the two writes) are skipped by undo and logged to Datadog — coordinator handles manually.

**Undo of a conversion:**
1. `POST /pipeline/memberships/:post_import_membership_id/close` — closes the newly-created membership (e.g., in_treatment), setting `status = 'closed'` and `closed_reason = 'import_undo'`. Body: `{ triggered_by: import.uploaded_by, reason: "import_undo" }`. This endpoint does not publish a `lead.stage_changed` event (internal cleanup). Setting `status = 'closed'` (not `'archived'`) is required so the `UNIQUE (lead_id, pipeline) WHERE status = 'active'` constraint allows re-enrollment in the next step.
2. `POST /pipeline/memberships` — re-enrolls lead in `pre_import_pipeline` at `pre_import_stage`. Body: `{ lead_id, location_id: import.location_id, pipeline: snapshot.pre_import_pipeline, stage: snapshot.pre_import_stage, triggered_by, reason: "import_undo" }`. `location_id` is taken from `imports.location_id` (not stored in the snapshot).

The original closed membership from before the import is not restored. A fresh enrollment is created. The complete transition history remains in `pipeline_stage_history` for audit.

---

## 9. Column Mapping

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

On subsequent uploads of the same import type: auto-detection runs first; saved mapping overrides matching entries; remaining unmapped headers shown to coordinator for manual assignment.

`imports.column_mapping` stores the coordinator's **confirmed** mapping (submitted at `POST /imports/:id/confirm` time) as the authoritative snapshot for that import. The parse phase runs earlier using the auto-detected + globally-saved mapping, but the coordinator's confirmed mapping supersedes this and is what gets recorded on the import row. This is correct: the coordinator explicitly reviews and confirms the mapping before execution, so the confirmed mapping is the one that matters for audit and re-run purposes.

**`POST /imports/:id/confirm` does not re-run match logic.** It executes the existing matched `import_rows` as-is. If the coordinator corrects a column mapping at confirm time in a way that would materially affect match quality (e.g., the phone column was misidentified during parse), they must cancel the import and re-upload to get a fresh parse with the corrected mapping applied.

---

## 10. Downstream Effects

Data Import Service publishes no EventBridge events. All downstream effects are driven by Pipeline Engine's existing event publishing:

| Import Action | Pipeline Engine Events | Downstream Effect |
|---|---|---|
| Transition → `contract_signed` + convert to In Treatment | `lead.stage_changed` + `lead.converted` | Automation Engine cancels active nurture sequences; Lead Service updates cache; Analytics logs conversion; Referral Service reacts to `lead.converted` event to create `reward_events` row |
| Transition → `treatment_complete` + convert to In Retention | `lead.stage_changed` + `lead.converted` | Automation Engine starts retention sequences; Referral Service creates patient referrer (`referrer.created`) |
| Transition → `exam_scheduled` | `lead.stage_changed` | Automation Engine starts appointment confirmation sequence |
| Transition → `contacted` (no_show) | `lead.stage_changed` (reason: `no_show`) | Automation Engine triggers no-show re-engagement sequence |

---

## 11. Service Layout

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
│   │   ├── pipeline-engine.ts     # typed HTTP client for Pipeline Engine
│   │   └── lead-service.ts        # typed HTTP client for Lead Service
│   ├── mapping/
│   │   └── ortho2-headers.ts      # hardcoded Ortho2 → CRM field map
│   ├── repositories/
│   │   ├── import.repo.ts
│   │   ├── import-row.repo.ts
│   │   └── column-mapping.repo.ts
│   └── index.ts
├── migrations/
├── test/
├── Dockerfile
├── package.json
└── tsconfig.json
```

**Runtime dependencies:**
- PostgreSQL (shared RDS cluster, `crm_imports` schema)
- Redis (BullMQ job queue)
- AWS S3 (CSV file storage)
- Pipeline Engine (direct HTTP, service API key)
- Lead Service (direct HTTP, service API key)

---

## 12. Testing Strategy

### Unit Tests (Vitest)

- `match.service.ts` — all 5 tiers; exact match, ambiguous, no match; batch prefetch map resolution
- `ortho2-headers.ts` — known header names map to correct CRM fields; unknown headers return undefined
- `undo.service.ts` — snapshot shape validation; transition undo calls correct Pipeline Engine endpoint; conversion undo calls close + re-enroll in correct order
- `import.service.ts` — `undo_deadline` computed correctly; status transition guards (confirm on non-preview_ready → error; undo after deadline → error)

### Integration Tests (Vitest + real Postgres)

Pipeline Engine and Lead Service mocked via HTTP interceptors:

- Parse phase — happy path: CSV parsed, rows matched, `status = preview_ready`
- Parse phase — all rows unmatched: `status = preview_ready`, `matched_count = 0`
- Parse phase — S3 read failure: `status = failed`
- Confirm — saves global column mapping upsert; second confirm on same import → `409`
- Execute phase — active_patients: transition + convert called in order; `before_snapshot` written before calls; `post_import_membership_id` written after convert; row `status = executed`
- Execute phase — partial failure: failed row marked, subsequent rows continue; import `status = completed`
- Execute phase — crash recovery: rows in `executing` status skipped on restart
- Undo — transition type: Pipeline Engine transition called with pre-import stage
- Undo — conversion type: close called first, then re-enroll; correct pipeline/stage from snapshot
- Undo — past deadline: `422 undo_window_expired`
- Undo — `executing` rows skipped (logged only)
- no_shows — unexpected stage guard: row marked `failed` if lead not at `exam_scheduled`

### Contract Tests

- Pipeline Engine calls always include `override: true` and non-null `triggered_by`
- `channel: "import"` on all `/convert` calls
- `before_snapshot` always written before any Pipeline Engine call (verified by interceptor call order)

---

## 13. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Async job processing | BullMQ, single job type with phase field | Large CSVs (thousands of rows) would timeout synchronously; phase field keeps state machine simple without multiple job types |
| `override: true` always | Pass `triggered_by` + `override: true` on all Pipeline Engine calls | Imports are human-initiated; coordinator is accountable; leads may be at arbitrary stages when batch-imported from Ortho2 |
| Direct service calls | Pipeline Engine + Lead Service via service API key | CRM API Gateway is for external callers; service-to-service uses direct calls per established pattern (Reporting Service → Analytics) |
| No events published | Downstream effects via Pipeline Engine events | Pipeline Engine already publishes `lead.stage_changed` / `lead.converted`; adding import-specific events would duplicate signal |
| Global column mapping | One saved mapping per import type | All 34 locations use the same Ortho2 version; per-location mappings add storage with no practical benefit |
| Full conversion undo | Close new membership + re-enroll in prior pipeline | Coordinators expect "undo" to mean fully reversible; soft flag-for-review doesn't meet that expectation at scale |
| Sequential execution | `row_number ASC` order | Predictable undo ordering (reverse row_number); avoids Pipeline Engine contention on same lead from concurrent rows |
| Partial success | Continue on per-row failure | A bad row in a 200-row import shouldn't block 199 good updates; failure details visible in row preview |

---

## 14. Pending Amendments to Other Specs

1. **Pipeline Engine spec** — Add `POST /pipeline/memberships/:id/close` endpoint. Body: `{ triggered_by, reason: "import_undo" }`. Sets `status = 'closed'` (not `'archived'`) and `closed_reason = 'import_undo'` on the membership row. Returns `200` membership. `409` if already closed/archived. Publishes no event. Also amend two enums: (a) add `"import_undo"` to `pipeline_stage_history.reason` CHECK constraint (current values: `manual | timeout | no_show | converted | import`); (b) add `"import_undo"` to `pipeline_memberships.closed_reason` CHECK constraint (current values: `converted | archived | manual | import`).

2. **Lead Service spec** — Add `date_of_birth date nullable` column to `leads` table (required for Tier 4 match logic).

3. **Lead Service spec** — Add `DELETE /leads/:id/appointments/:appointment_id` endpoint. Restricted to service API key callers (`IMPORT_SERVICE_API_KEY`). Used for appointment undo.

4. **Lead Service spec** — Add bulk lookup query params to `GET /leads`: `phones[]` (array of E.164 strings) and `emails[]` (array of email strings). Returns all matching leads. Used by parse phase batch prefetch.

5. **Arch doc** — Document `IMPORT_SERVICE_API_KEY` as a service-to-service credential (same pattern as `ANALYTICS_API_KEY` used by Reporting Service). Add Data Import Service to the REST call table as consumer of Pipeline Engine and Lead Service.

6. **Automation Engine spec** — Confirm that `lead.stage_changed` with `reason: "no_show"` is a supported trigger condition in the trigger catalog. Document the no-show re-engagement workflow (triggered by `reason == "no_show"` on stage transition to `contacted`) if not already present.
