# Pipeline Engine — Updated Design Spec

**Date:** 2026-04-07
**Status:** Approved
**Scope:** Product-layer Pipeline Engine — state machine for 3 pipelines / 13 stages, stage transition validation, timeout enforcement, event publishing. This document supersedes `2026-03-25-pipeline-engine-design.md` and incorporates all implementation decisions from the Q&A session (`tasks/prd-questions-pipeline-engine.md`).

---

## 1. Overview

The Pipeline Engine is a **product-layer service** (`apps/crm/pipeline`) that owns the canonical pipeline state for every lead in the CRM. It manages a hardcoded state machine across three pipelines and 13 stages, validates transitions, enforces time limits via a polling job, and publishes domain events that drive downstream automation.

**Core responsibilities:**
- Store pipeline membership state in `crm_pipeline` schema (source of truth)
- Validate stage transitions against a hardcoded transition graph
- Allow coordinator override of the graph with an `override` flag
- Enforce stage time limits via a `croner` polling job (every 15 min)
- Publish `lead.stage_changed`, `lead.converted`, `lead.stage_timeout`, and `lead.archived` to EventBridge
- Support atomic pipeline conversion (e.g. New Patient → In Treatment)

**Out of scope:**
- Sending messages or executing automation actions — Pipeline Engine only emits events; Automation Engine acts
- Subscribing to EventBridge events — all transitions come in via REST through the CRM API Gateway
- Storing lead identity data (name, phone, attribution) — owned by Lead Service
- Redis or BullMQ — timeout enforcement uses `croner` polling, no queue infrastructure needed

---

## 2. Architecture

```
CRM API Gateway (all callers: coordinators, Data Import Service, Automation Engine)
        │
        ▼ REST (all transitions) — X-Internal-Api-Key header validated by Pipeline Engine
┌──────────────────────────────────────────────────────┐
│               Pipeline Engine                         │
│           apps/crm/pipeline                           │
│                                                       │
│  routes/           services/           jobs/          │
│  memberships  →  state-machine.ts  ←  timeout-poll   │
│  transitions  →  transition.service    (croner        │
│  conversions  →  convert.service        every 15min)  │
│  history                                              │
│                                                       │
│  repositories/          events/                       │
│  membership.repo    →   publisher.ts                  │
│  stage-history.repo                                   │
└──────────────────────────────────────────────────────┘
        │                         │
        ▼ writes                  ▼ publishes (post-commit)
  crm_pipeline schema       AWS EventBridge
  pipeline_memberships       lead.stage_changed
  pipeline_stage_history     lead.converted
                             lead.stage_timeout
                                  │
                    ┌─────────────┼──────────────┐
                    ▼             ▼               ▼
              Lead Service  Automation Engine  Analytics
              (cache sync)  (trigger rules)   (metrics)
```

**Key properties:**
- No Redis or BullMQ — timeout enforcement uses `croner`; no queue infrastructure needed
- No EventBridge subscriptions — Pipeline Engine is REST-only inbound
- Source of truth in `crm_pipeline`; Lead Service cache updated asynchronously via `lead.stage_changed`
- Every stage change is a single DB transaction (UPDATE membership + INSERT history), then post-commit event publish

**Golden rule compliance:** Pipeline Engine never calls Messaging Service, AI Service, or any platform service directly. All side effects are driven by Automation Engine reacting to published events.

---

## 3. Runtime Configuration

### 3.1 Package

```json
{
  "name": "@ortho/pipeline-engine",
  "type": "module"
}
```

### 3.2 Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | yes | — | PostgreSQL connection string |
| `PORT` | no | `3005` | HTTP listen port |
| `INTERNAL_API_KEY` | yes | — | Shared secret validated on every inbound request (see §3.3) |
| `EVENTBRIDGE_BUS_NAME` | yes | — | AWS EventBridge event bus name |
| `AWS_REGION` | yes | — | AWS region |
| `TIMEOUT_POLL_ENABLED` | no | `true` | Set to `false` to disable the cron job (useful in integration tests that call the poll function directly) |
| `LOG_LEVEL` | no | `info` | Pino log level |

### 3.3 Internal Auth Middleware

The CRM API Gateway is the sole external caller. Pipeline Engine enforces a shared-secret check on every route:

```typescript
// src/plugins/internal-auth.ts
fastify.addHook('onRequest', async (request, reply) => {
  const key = request.headers['x-internal-api-key']
  if (key !== process.env.INTERNAL_API_KEY) {
    return reply.status(401).send({ error: 'unauthorized' })
  }
})
```

No JWT parsing or RBAC logic — the Gateway handles all that before forwarding. The `triggered_by` and `override` fields in request bodies are trusted as-is.

### 3.4 Database Setup

Knex is configured directly in the service (not via `@ortho/db`). The `searchPath` is set to `crm_pipeline` so all queries use unqualified table names (`pipeline_memberships`, not `crm_pipeline.pipeline_memberships`).

```typescript
// src/db.ts
import Knex from 'knex'

export const db = Knex({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  searchPath: ['crm_pipeline'],
  pool: { min: 2, max: 10 },
})
```

Migrations are owned by the service and use a timestamp-prefix naming convention:

```
migrations/
  20260325000000_create_crm_pipeline_schema.ts
  20260325000001_create_pipeline_memberships.ts
  20260325000002_create_pipeline_stage_history.ts
```

Each migration creates or alters tables within the `crm_pipeline` schema. The first migration creates the schema itself (`CREATE SCHEMA IF NOT EXISTS crm_pipeline`).

---

## 4. State Machine

Pipelines and stages are hardcoded in `src/services/state-machine.ts` as TypeScript constants. No DB-configurable stages — the three pipelines are fixed by the product domain. Stage changes require a deploy.

### 4.1 New Patient Pipeline (7 stages)

| Stage | Timeout | Timeout Stage | Notes |
|---|---|---|---|
| `new_lead` | None (UI warning at 2h) | — | `entered_stage_at` shown in UI; no auto-transition |
| `contacted` | 5 days | `lost` | |
| `exam_scheduled` | None | — | No-show handled by coordinator action |
| `exam_completed` | 7 days | `lost` | |
| `tx_presented` | 14 days | `lost` | |
| `contract_signed` | None | — | Terminal — triggers `/convert` to In Treatment |
| `lost` | 30 days | archived | After 30d: `status = archived`, no new stage |

**Valid automated transitions (strict graph):**

| From | To |
|---|---|
| `new_lead` | `contacted`, `lost` |
| `contacted` | `exam_scheduled`, `lost` |
| `exam_scheduled` | `exam_completed`, `contacted` (no-show) |
| `exam_completed` | `tx_presented`, `lost` |
| `tx_presented` | `contract_signed`, `lost` |
| `lost` | `contacted` (re-engagement) |

Coordinator-initiated requests may include `override: true` to bypass the graph and move to any stage within the same pipeline. RBAC enforcement (only `call_center_manager`, `marketing_manager`, and `super_admin` may set `override: true` — `call_center_agent` may not bypass the transition graph) is performed by the CRM API Gateway before forwarding. `super_admin` bypasses all Gateway permission checks and may always set `override: true`.

### 4.2 In Treatment Pipeline (3 stages)

| Stage | Timeout | Notes |
|---|---|---|
| `new_patient` | None | Entry stage on conversion from New Patient |
| `in_treatment` | None | Duration varies per patient |
| `treatment_complete` | None | Terminal — triggers `/convert` to In Retention |

**Valid automated transitions:** `new_patient → in_treatment → treatment_complete`

Entry: created by `/convert` when New Patient lead reaches `contract_signed`. Exit: `treatment_complete` triggers `/convert` to In Retention (via CSV import or future EHR event).

### 4.3 In Retention Pipeline (3 stages)

| Stage | Timeout | Timeout Stage | Notes |
|---|---|---|---|
| `active_retention` | None | — | Entry stage on conversion from In Treatment |
| `recall_due` | Variable | `long_term_follow` | Caller provides `timeout_at` (absolute datetime — the recall appointment date) |
| `long_term_follow` | None | — | Can loop back to `active_retention` |

**Valid automated transitions:** `active_retention → recall_due → long_term_follow → active_retention`

Entry: created by `/convert` when In Treatment lead reaches `treatment_complete`.

### 4.4 State Machine TypeScript Shape

```typescript
interface StageConfig {
  pipeline: 'new_patient' | 'in_treatment' | 'in_retention'
  timeoutDays: number | null    // null = no timeout; poller skips (recall_due uses caller-provided timeout_at)
  timeoutStage: string | null   // null = archive (for lost) or no timeout
  requiresCallerTimeoutAt: boolean  // true = caller must provide timeout_at in transition request
  allowedTransitions: string[]  // valid next stages for automated calls
}

const STAGES: Record<string, StageConfig> = {
  new_lead:           { pipeline: 'new_patient',  timeoutDays: null, timeoutStage: null,               requiresCallerTimeoutAt: false, allowedTransitions: ['contacted', 'lost'] },
  contacted:          { pipeline: 'new_patient',  timeoutDays: 5,    timeoutStage: 'lost',             requiresCallerTimeoutAt: false, allowedTransitions: ['exam_scheduled', 'lost'] },
  exam_scheduled:     { pipeline: 'new_patient',  timeoutDays: null, timeoutStage: null,               requiresCallerTimeoutAt: false, allowedTransitions: ['exam_completed', 'contacted'] },
  exam_completed:     { pipeline: 'new_patient',  timeoutDays: 7,    timeoutStage: 'lost',             requiresCallerTimeoutAt: false, allowedTransitions: ['tx_presented', 'lost'] },
  tx_presented:       { pipeline: 'new_patient',  timeoutDays: 14,   timeoutStage: 'lost',             requiresCallerTimeoutAt: false, allowedTransitions: ['contract_signed', 'lost'] },
  contract_signed:    { pipeline: 'new_patient',  timeoutDays: null, timeoutStage: null,               requiresCallerTimeoutAt: false, allowedTransitions: [] },
  lost:               { pipeline: 'new_patient',  timeoutDays: 30,   timeoutStage: null,               requiresCallerTimeoutAt: false, allowedTransitions: ['contacted'] },
  new_patient:        { pipeline: 'in_treatment', timeoutDays: null, timeoutStage: null,               requiresCallerTimeoutAt: false, allowedTransitions: ['in_treatment'] },
  in_treatment:       { pipeline: 'in_treatment', timeoutDays: null, timeoutStage: null,               requiresCallerTimeoutAt: false, allowedTransitions: ['treatment_complete'] },
  treatment_complete: { pipeline: 'in_treatment', timeoutDays: null, timeoutStage: null,               requiresCallerTimeoutAt: false, allowedTransitions: [] },
  active_retention:   { pipeline: 'in_retention', timeoutDays: null, timeoutStage: null,               requiresCallerTimeoutAt: false, allowedTransitions: ['recall_due'] },
  recall_due:         { pipeline: 'in_retention', timeoutDays: null, timeoutStage: 'long_term_follow', requiresCallerTimeoutAt: true,  allowedTransitions: ['long_term_follow'] },
  long_term_follow:   { pipeline: 'in_retention', timeoutDays: null, timeoutStage: null,               requiresCallerTimeoutAt: false, allowedTransitions: ['active_retention'] },
}
```

`recall_due` has `timeoutDays: null` and `requiresCallerTimeoutAt: true` — its timeout is the patient's recall appointment date, which varies per patient. The caller must provide `timeout_at` (absolute datetime) in the transition request body. `transition.service.ts` validates this: `400` if `stage == 'recall_due' && timeout_at` is absent. `computeTimeoutAt(stage, enteredAt, callerProvidedTimeoutAt?)` returns `callerProvidedTimeoutAt` for this stage and ignores `enteredAt`. The poller uses the stored `timeout_at` value directly. When `recall_due` times out, the poller transitions to `long_term_follow` and publishes both `lead.stage_changed` + `lead.stage_timeout` (identical to all other non-null `timeoutStage` cases).

`lost` has `timeoutStage: null` — when `lost` times out after 30 days, the poller sets `status = 'archived'` on the membership. No stage transition occurs and no `lead.stage_changed` is published. Instead, a dedicated `lead.archived` event is published (see §7 and §8).

---

## 5. Database Schema — `crm_pipeline`

### `pipeline_memberships`

One row per pipeline enrollment per lead. Updated in-place as the lead advances through stages. At most one `status = 'active'` row per `(lead_id, pipeline)`.

```sql
id                        uuid         PRIMARY KEY DEFAULT gen_random_uuid()
lead_id                   uuid         NOT NULL             -- opaque ref, no FK across schemas
location_id               uuid         NOT NULL             -- for scoped queries + event payloads
pipeline                  varchar      NOT NULL             -- new_patient|in_treatment|in_retention
stage                     varchar      NOT NULL             -- current stage
status                    varchar      NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'closed', 'archived'))
entered_stage_at          timestamptz  NOT NULL DEFAULT now()  -- reset on each transition
timeout_at                timestamptz  NULL                 -- NULL = no timeout; set at transition time
previous_stage            varchar      NULL                 -- stage before current (UI convenience)
last_transition_override  boolean      NOT NULL DEFAULT false
closed_at                 timestamptz  NULL
closed_reason             varchar      NULL
                          CHECK (closed_reason IN ('converted', 'archived', 'manual', 'import', 'import_undo'))
                          -- 'converted': moved to another pipeline via /convert
                          -- 'archived': lost stage timed out after 30 days
                          -- 'manual': manually closed by coordinator
                          -- 'import': closed via Data Import Service
                          -- 'import_undo': membership closed as part of a Data Import undo operation
created_at                timestamptz  NOT NULL DEFAULT now()
updated_at                timestamptz  NOT NULL DEFAULT now()
```

**Indexes:**
```sql
UNIQUE (lead_id, pipeline) WHERE status = 'active'    -- one active enrollment per lead+pipeline
INDEX (pipeline, stage, status, timeout_at)            -- timeout polling scan
INDEX (location_id, pipeline, stage, status)           -- lead queue queries
INDEX (lead_id)                                        -- lookup by lead
```

### `pipeline_stage_history`

Immutable log. One row per stage transition. Never updated or deleted.

```sql
id               uuid         PRIMARY KEY DEFAULT gen_random_uuid()
membership_id    uuid         NOT NULL REFERENCES pipeline_memberships(id)
lead_id          uuid         NOT NULL    -- denormalized to avoid join
pipeline         varchar      NOT NULL    -- denormalized
stage_from       varchar      NULL        -- NULL on initial enrollment
stage_to         varchar      NOT NULL    -- always a valid stage name; archival writes a dedicated lead.archived event, not a history row with null stage_to
override         boolean      NOT NULL DEFAULT false
triggered_by     uuid         NULL        -- user_id; NULL for automated transitions
reason           varchar      NULL        -- manual|timeout|no_show|converted|import|import_undo
transitioned_at  timestamptz  NOT NULL DEFAULT now()
```

**Indexes:**
```sql
INDEX (membership_id)
INDEX (lead_id, transitioned_at DESC)    -- full lead timeline across all pipelines
```

### Atomic write pattern

Every stage change is a single DB transaction:
1. `UPDATE pipeline_memberships` — set `stage`, `entered_stage_at`, `timeout_at`, `previous_stage`, `last_transition_override`, `updated_at`
2. `INSERT pipeline_stage_history` — log the transition
3. COMMIT → then publish event to EventBridge (post-commit, fire-and-forget)

If EventBridge publish fails after commit, the DB state stands. The stage change is not rolled back.

---

## 6. API

All endpoints are called by the CRM API Gateway. RBAC is enforced at the Gateway — Pipeline Engine trusts the forwarded `triggered_by` and `override` fields. All request bodies and response shapes are validated using full TypeBox schemas (`@sinclair/typebox` + Fastify's built-in schema validation). Unexpected server-side failures return `500 { "error": "internal_error" }`.

All routes are registered under a `/pipeline` Fastify plugin prefix. The service's full path is `/pipeline/memberships`, `/pipeline/memberships/:id/transition`, etc.

### `POST /pipeline/memberships`
Enroll a lead in a pipeline at an initial stage. Publishes `lead.stage_changed` post-commit (`stage_from: null`).

**Request:**
```json
{
  "lead_id":      "uuid",
  "location_id":  "uuid",
  "pipeline":     "new_patient",
  "stage":        "new_lead",
  "triggered_by": "user-uuid",    // null for automated enrollment (e.g. Data Import Service)
  "reason":       "manual",       // manual|import
  "timeout_at":   "2026-03-26T..."  // optional override
}
```

**Response:** `201` membership object. `409` if an active membership already exists for `(lead_id, pipeline)`. `400` if `stage == 'recall_due'` and `timeout_at` is absent (same guard as the transition endpoint). Publishes `lead.stage_changed` post-commit with `stage_from: null` and the caller-supplied `reason`.

---

### `POST /pipeline/memberships/:id/transition`
Move a lead to a new stage within the same pipeline.

**Request:**
```json
{
  "stage":        "contacted",
  "override":     false,
  "triggered_by": "user-uuid",   // null for automated transitions
  "reason":       "manual",      // manual|timeout|no_show|import|import_undo
  "timeout_at":   "..."          // required when transitioning to recall_due
}
```

**Responses:**
- `200` — updated membership object
- `400` — `timeout_at` missing when transitioning to `recall_due`: `{ "error": "timeout_at_required" }`
- `422` — invalid transition: `{ "error": "invalid_transition", "from": "new_lead", "to": "tx_presented", "allowed": ["contacted", "lost"] }`
- `409` — membership is not `active`

Graph check is skipped when `override: true`. The Gateway enforces that only coordinator roles may set `override: true`.

**Concurrency:** `transition.service.ts` reads the membership row with `SELECT ... FOR UPDATE` before validating and applying the transition. This serializes concurrent requests on the same membership row, preventing duplicate history rows or double-fired events from two simultaneous calls.

**Override constraint:** `override: true` requires a non-null `triggered_by`. Pipeline Engine returns `400` if `override: true && triggered_by == null` — automated callers (Data Import Service, Automation Engine) may not bypass the transition graph.

**`reason` field:** Informational only — no cross-field validation between `stage` and `reason`. The `no_show` value is conventionally used for `exam_scheduled → contacted` but is not enforced by the engine.

**`404` responses:** Both `POST /memberships/:id/transition` and `POST /memberships/:id/convert` return `404` if the `:id` does not exist.

---

### `POST /pipeline/memberships/:id/convert`
Atomically close the source membership and open a new one in the target pipeline.

**Request:**
```json
{
  "to_pipeline":  "in_treatment",
  "to_stage":     "new_patient",
  "triggered_by": "user-uuid",
  "reason":       "converted",
  "channel":      "google_ads"    // attribution channel — included in lead.converted payload
}
```

Valid `channel` values (must match exactly — `400` otherwise): `google_ads` | `facebook` | `website` | `referral_patient` | `referral_doctor` | `call_tracking` | `walk_in` | `chat` | `google_business` | `import` | `unknown`. The CRM API Gateway is responsible for resolving the lead's attribution channel from Lead Service before calling this endpoint.

**Valid conversions** (only these source/target pairs are accepted — `422` otherwise):

| From pipeline | From stage (required) | To pipeline | To stage |
|---|---|---|---|
| `new_patient` | `contract_signed` | `in_treatment` | `new_patient` |
| `in_treatment` | `treatment_complete` | `in_retention` | `active_retention` |

**Response:** `201` — new membership object. Single DB transaction (with `SELECT ... FOR UPDATE` on the source membership to prevent concurrent double-conversion): source membership → `status: closed, closed_reason: converted`; new membership created; two history rows inserted (source: `stage_from: <from_stage>, stage_to: <from_stage>, reason: 'converted'`; target: `stage_from: null, stage_to: <to_stage>, reason: 'converted'`). Post-commit, publishes **both** `lead.converted` AND `lead.stage_changed` (with `stage_from: null`, `stage_to: <to_stage>`, `reason: 'converted'`) for the new membership, so Analytics `metrics_pipeline_daily` and Automation Engine stage-based rules receive the new stage entry signal. Returns `422` if the source membership's current stage does not match the required `from_stage` for the conversion.

---

### `POST /pipeline/memberships/:id/close`
Directly close an active membership without transitioning to another pipeline. Used exclusively by the Data Import Service undo flow.

**Request:**
```json
{
  "triggered_by": "user-uuid",
  "closed_reason": "import_undo"
}
```

**Responses:**
- `200` — updated membership object (`status: "closed"`, `closed_reason: "import_undo"`)
- `400` — missing `triggered_by`
- `409` — membership is not `active`

**Behaviour:** Sets `pipeline_memberships.status = 'closed'`, `closed_reason = 'import_undo'`, `closed_at = NOW()`. Does NOT insert a `pipeline_stage_history` row — no stage transition occurred. Does NOT publish any EventBridge event — the undo caller (Data Import Service) handles any necessary downstream notifications. RBAC is enforced at the CRM API Gateway; only the Data Import Service (via API key) may call this endpoint.

---

### Query endpoints

| Method | Path | Query params | Response |
|---|---|---|---|
| `GET` | `/pipeline/memberships` | `lead_id`, `pipeline`, `stage`, `location_id`, `status`, `cursor`, `limit` | Paginated list (default 50). Default `status` filter: **all statuses** (active + closed + archived). Pass `status=active` to get only live memberships — this is the query Lead Service uses for cache seeding on startup. The CRM API Gateway **must** inject `location_id` from the JWT `locations[]` claim before forwarding for non-super_admin callers; Pipeline Engine does not independently re-validate location scope on list queries. Cursor: opaque base64-encoded `{ id, created_at }` of the last row; sort order is `created_at ASC, id ASC`. |
| `GET` | `/pipeline/memberships/:id` | — | Single membership. `404` if not found. |
| `GET` | `/pipeline/memberships/:id/history` | — | Array of history rows, `transitioned_at ASC`. `404` if membership not found. |

**Error shape** (consistent with other services): `{ "error": "<message>" }`

---

## 7. Events Published

All events are published to EventBridge post-commit via `@ortho/event-bus`. The `OrthoEvent` envelope includes `event_id` (added to the envelope — not nested in `payload`) and `schema_version: '1.0'` on all four event types. `correlation_id` is forwarded from the inbound HTTP request's `X-Correlation-Id` header; if the header is absent, a fresh `randomUUID()` is generated.

**Full envelope shape:**
```typescript
interface OrthoEvent<T> {
  event_id:       string   // uuid — added to envelope (not in payload)
  event_type:     string
  entity_type:    string
  entity_id:      string
  schema_version: '1.0'
  correlation_id: string   // forwarded X-Correlation-Id or generated
  payload:        T
}
```

**Event bus startup:** `bus.start()` is called at service startup for consistency, even though Pipeline Engine is publish-only and no subscriptions are registered. `bus.stop()` is always called in the SIGTERM handler.

### `lead.stage_changed`

Published on every stage transition, including initial enrollment (`stage_from: null`).

```json
{
  "event_id":      "uuid",
  "event_type":    "lead.stage_changed",
  "entity_type":   "lead",
  "entity_id":     "<lead_id>",
  "schema_version": "1.0",
  "correlation_id": "...",
  "payload": {
    "membership_id":          "uuid",
    "lead_id":                "uuid",
    "location_id":            "uuid",
    "pipeline":               "new_patient",
    "stage_from":             "new_lead",
    "stage_to":               "contacted",
    "override":               false,
    "triggered_by":           "user-uuid",
    "reason":                 "manual",
    "timeout_at":             "...",
    "transitioned_at":        "...",
    "time_in_stage_seconds":  7200,
    "response_time_seconds":  3600
  }
}
```

**`time_in_stage_seconds`** — always present when `stage_from` is not null. Computed as `transitioned_at - entered_stage_at` (time spent in the previous stage). Null on initial enrollment (`stage_from: null`).

**`response_time_seconds`** — present only when `stage_to = 'contacted'` AND `stage_from` is not null AND `triggered_by` is non-null (coordinator-initiated). Computed as `transitioned_at - membership.created_at` (time from lead creation to first contact attempt). Null in all other cases.

**Subscribers:** Lead Service (cache sync), Automation Engine (rule evaluation), Analytics Service (pipeline metrics).

### `lead.converted`

Published by `/convert` endpoint after atomic pipeline conversion commits.

```json
{
  "event_id":      "uuid",
  "event_type":    "lead.converted",
  "entity_type":   "lead",
  "entity_id":     "<lead_id>",
  "schema_version": "1.0",
  "correlation_id": "...",
  "payload": {
    "lead_id":           "uuid",
    "location_id":       "uuid",
    "from_pipeline":     "new_patient",
    "from_stage":        "contract_signed",
    "to_pipeline":       "in_treatment",
    "to_stage":          "new_patient",
    "new_membership_id": "uuid",
    "channel":           "google_ads",
    "triggered_by":      "user-uuid",
    "converted_at":      "..."
  }
}
```

**Subscribers:** Analytics Service (`metrics_conversions_daily`; uses `location_id` + `channel`), Automation Engine (welcome-to-treatment rules), Lead Service (locks attribution). Note: `/convert` also publishes a `lead.stage_changed` (with `stage_from: null`, `reason: 'converted'`) for the new pipeline enrollment — Lead Service updates `current_pipeline` / `current_stage` from that event, not from `lead.converted`.

### `lead.stage_timeout`

Published by the timeout polling job after the auto-transition commits. The same transition also publishes `lead.stage_changed` (with `reason: "timeout"`). Automation Engine can react to either — `lead.stage_timeout` provides additional context (which stage timed out, by how much).

```json
{
  "event_id":      "uuid",
  "event_type":    "lead.stage_timeout",
  "entity_type":   "lead",
  "entity_id":     "<lead_id>",
  "schema_version": "1.0",
  "correlation_id": "uuid",
  "payload": {
    "membership_id":       "uuid",
    "lead_id":             "uuid",
    "location_id":         "uuid",
    "pipeline":            "new_patient",
    "timed_out_stage":     "contacted",
    "new_stage":           "lost",
    "timed_out_at":        "...",
    "exceeded_by_seconds": 3600
  }
}
```

Note: timeout-poll events are not triggered by an inbound HTTP request. `correlation_id` is generated as `randomUUID()` per batch row.

**Subscribers:** Automation Engine (re-engagement SMS, coordinator alerts, task creation).

### `lead.archived`

Published by the timeout polling job when a `lost` membership's 30-day re-engagement window expires. This is a terminal event — the lead is no longer active in any pipeline. It is a dedicated event type (not `lead.stage_changed`) to avoid ambiguity in downstream handlers that require a non-null `stage_to`.

```json
{
  "event_id":      "uuid",
  "event_type":    "lead.archived",
  "entity_type":   "lead",
  "entity_id":     "<lead_id>",
  "schema_version": "1.0",
  "correlation_id": "uuid",
  "payload": {
    "membership_id": "uuid",
    "lead_id":       "uuid",
    "location_id":   "uuid",
    "pipeline":      "new_patient",
    "archived_at":   "..."
  }
}
```

**Subscribers:** Lead Service (clears `current_pipeline` / `current_stage` cache fields), Automation Engine (cancel any in-flight sequences for this lead).

> **Analytics cross-reference:** The `lead.stage_changed` payload includes all fields required by Analytics Service (`location_id`, `pipeline`, `stage_to`). The `lead.converted` payload includes `location_id` and `channel`. These payload shapes satisfy the pending amendment documented in the Analytics Service spec.

---

## 8. Timeout Polling Job

`src/jobs/timeout-poll.job.ts` — `croner` scheduled every 15 minutes inside the Pipeline Engine process. Controlled by `TIMEOUT_POLL_ENABLED` env var (default `true`). Integration tests that call the poll function directly set `TIMEOUT_POLL_ENABLED=false` to prevent the scheduler from also firing.

### Execution flow

1. **Guard:** skip run if a previous run is still in progress within this instance (in-process `isRunning` flag prevents re-entrancy within one ECS task — not a cross-instance lock; see multi-instance note below)
2. **Query** up to 100 overdue active memberships using raw SQL for `FOR UPDATE SKIP LOCKED`:
   ```typescript
   await db.raw(`
     SELECT * FROM pipeline_memberships
     WHERE status = 'active'
       AND timeout_at IS NOT NULL
       AND timeout_at < NOW()
     ORDER BY timeout_at ASC
     LIMIT 100
     FOR UPDATE SKIP LOCKED
   `)
   ```
3. **For each overdue row** (individual transaction per row):
   - Look up `timeoutStage` from hardcoded `STAGES` config
   - If `timeoutStage` is a stage name (e.g. `contacted → lost`, `recall_due → long_term_follow`): run atomic write (UPDATE membership + INSERT history, `reason: 'timeout'`), then publish `lead.stage_changed` (reason: `'timeout'`) + `lead.stage_timeout`
   - If `timeoutStage` is `null` (i.e. `lost` timing out after 30 days): UPDATE membership `status = 'archived'`, `closed_reason = 'archived'` — **no history row inserted, no `lead.stage_changed` published** (archival is not a stage transition). Publish dedicated `lead.archived` event so Lead Service clears its cache and Automation Engine can react.
4. **Log** summary using structured log levels:
   - `info` — per-run summary (N leads processed)
   - `error` — per-row failures (logged to Datadog)
   - `warn` — when the batch hits the 100-row cap (signals backlog)

### Graceful shutdown

On SIGTERM:
1. Set `isRunning` flag to prevent new runs from starting
2. Let the current batch complete (if one is in progress)
3. Call `task.stop()` on the croner task to deregister the schedule

```typescript
process.on('SIGTERM', async () => {
  cronTask.stop()         // deregister schedule
  await db.destroy()
  await bus.stop()        // always called, even though no subscriptions
  process.exit(0)
})
```

### Design properties

- **Multi-instance safety:** ECS Fargate deployments run multiple Pipeline Engine instances simultaneously. `FOR UPDATE SKIP LOCKED` is the cross-instance safety mechanism — each instance claims a disjoint set of rows. The in-process flag only prevents re-entrancy within a single instance and is not relied on for cross-instance correctness.
- **Idempotency:** Once a row is processed, its `timeout_at` is reset to the new stage's value (or `NULL`), so it won't reappear in future scans across any instance.
- **Per-row transactions:** A failure on one lead does not affect others. Failures are logged to Datadog; the row is retried on the next run 15 minutes later.
- **Batch cap of 100:** Sufficient for 34 locations at realistic lead volumes. Remainder caught in the next run (or processed concurrently by another instance). A `warn` log is emitted when the cap is hit.
- **Post-commit publish:** EventBridge publish failure after commit is logged to Datadog and does not roll back the DB state. Accepted risk: downstream caches (Lead Service) may diverge until the next corrective action. Mitigation: Lead Service can reseed its cache for a specific lead by calling `GET /pipeline/memberships?lead_id=...&status=active` directly. Persistent publish failures alert on-call via Datadog.
- **Archival audit trail:** When a `lost` membership is archived, no `pipeline_stage_history` row is inserted (archival is not a stage transition). The archival is recorded by `closed_reason = 'archived'` and `closed_at` on the membership row, and by the `lead.archived` event. `GET /memberships/:id/history` returns only stage transitions; callers building a complete lead timeline must also inspect the membership's `closed_reason` and `closed_at` to show the terminal archival state. `timeout_at` is set to `NULL` on the membership row during archival.
- **`new_lead` 2-hour window:** No `timeout_at` is set for `new_lead`. The UI reads `entered_stage_at` and displays a visual warning after 2 hours — no automated transition.

---

## 9. Logging

The service uses `@ortho/logger` (Pino, Datadog-compatible structured JSON). A child logger is created at the start of each request handler, binding all available IDs as they become known:

```typescript
const log = request.log.child({
  requestId:    request.id,
  leadId:       body.lead_id   ?? null,
  membershipId: params.id      ?? null,
  locationId:   body.location_id ?? null,
})
```

Additional IDs (e.g. `membershipId` after a DB lookup) are bound in service-layer logs as they resolve. The timeout poll job binds `{ jobRun: uuid }` at the start of each run.

---

## 10. Service Layout

```
apps/crm/pipeline/
├── src/
│   ├── plugins/
│   │   └── internal-auth.ts     # X-Internal-Api-Key hook
│   ├── routes/
│   │   ├── memberships.ts       # POST /pipeline/memberships, GET /memberships, GET /memberships/:id
│   │   ├── transitions.ts       # POST /memberships/:id/transition
│   │   ├── conversions.ts       # POST /memberships/:id/convert
│   │   ├── close.ts             # POST /memberships/:id/close
│   │   └── history.ts           # GET /memberships/:id/history
│   ├── services/
│   │   ├── state-machine.ts     # pure — STAGES constant, isValidTransition(), computeTimeoutAt(), getTimeoutStage()
│   │   ├── transition.service.ts  # validate + apply transition (calls state-machine, repo, publisher)
│   │   └── convert.service.ts     # atomic pipeline conversion
│   ├── repositories/
│   │   ├── membership.repo.ts
│   │   └── stage-history.repo.ts
│   ├── jobs/
│   │   └── timeout-poll.job.ts  # croner, every 15 min, controlled by TIMEOUT_POLL_ENABLED
│   ├── events/
│   │   └── publisher.ts         # EventBridge publish (lead.stage_changed, lead.converted, lead.stage_timeout, lead.archived)
│   ├── db.ts                    # Knex instance, searchPath: 'crm_pipeline'
│   └── index.ts
├── migrations/
│   ├── 20260325000000_create_crm_pipeline_schema.ts
│   ├── 20260325000001_create_pipeline_memberships.ts
│   └── 20260325000002_create_pipeline_stage_history.ts
├── test/
│   ├── unit/
│   │   └── state-machine.test.ts
│   ├── integration/
│   │   ├── memberships.test.ts
│   │   ├── transitions.test.ts
│   │   ├── conversions.test.ts
│   │   ├── close.test.ts
│   │   └── timeout-poll.test.ts
│   └── contract/
│       └── events.test.ts       # payload shape assertions for all four event types
├── Dockerfile
├── package.json
└── tsconfig.json
```

**Runtime dependencies:**
- PostgreSQL (shared RDS cluster, `crm_pipeline` schema)
- AWS EventBridge (publish only)
- No Redis · No BullMQ · No SQS subscription

---

## 11. Testing Strategy

### Unit Tests (Vitest)

Pure function coverage with no external dependencies (`state-machine.ts`):
- `isValidTransition(from, to, pipeline)` — all allowed pairs pass; all invalid pairs return false; override flag bypasses check
- `computeTimeoutAt(stage, enteredAt, callerProvidedTimeoutAt?)` — correct absolute datetime for fixed-duration stages; `null` for no-timeout stages; `recall_due` returns `callerProvidedTimeoutAt` (not null — the caller-supplied datetime is passed through)
- `getTimeoutStage(stage)` — correct target stage per stage; `null` for `lost` (archive behavior)

### Integration Tests (Vitest + real Postgres)

**Test DB setup:** Each test file creates its own schema via Knex migrations in `beforeAll` and drops it in `afterAll`. This isolates test files from each other and avoids shared state.

**Event bus mocking:** `MockDriver` is injected via `createEventBus({ driver: mockDriver })`. Assertions run against `mockDriver.published[]` — no HTTP interceptor needed.

Test cases:
- Enroll — happy path, correct `timeout_at` computed; `409` on duplicate active enrollment
- Valid transition — membership updated, history row inserted, `lead.stage_changed` published
- Invalid transition — `422` with `allowed[]` array; no DB write, no event
- Override transition — accepted regardless of graph; `last_transition_override: true` on membership
- Convert — source closed (`closed_reason: converted`), target created, two history rows, `lead.converted` published; idempotent (second call → `409`)
- Timeout poll — overdue row auto-transitioned; `lead.stage_changed` (reason: `timeout`) + `lead.stage_timeout` both published
- Timeout poll — `recall_due` expiry → transitions to `long_term_follow`; both events published (same path as all non-null `timeoutStage` cases)
- Timeout poll — `lost` 30-day expiry → `status = archived`; `lead.archived` published; no `lead.stage_changed`, no `lead.stage_timeout`
- Timeout poll — `SKIP LOCKED` prevents double-processing: `pg` (not Knex) is used directly to hold a lock on a row in one connection while the poll function runs in another; asserts the locked row is skipped
- `recall_due` transition — requires `timeout_at` in request body; `400` if missing
- Concurrent identical transition calls — second call serialized via `SELECT ... FOR UPDATE`; results in single history row and single event
- Close endpoint — sets `status: closed`, `closed_reason: import_undo`; no history row, no event
- Auth middleware — `401` when `X-Internal-Api-Key` header is absent or wrong

### Contract Tests (`test/contract/`)

Dedicated folder, separate from integration tests. Verifies published event payloads against `@ortho/event-bus` schema:
- `lead.stage_changed` — all required fields: `event_id`, `schema_version: '1.0'`, `correlation_id`, `location_id`, `pipeline`, `stage_to`, `reason`; `time_in_stage_seconds` present when `stage_from` is not null; `response_time_seconds` present when `stage_to = 'contacted'` AND `triggered_by` is non-null
- `lead.converted` — `event_id`, `schema_version`, `location_id` + `channel` present (required by Analytics Service)
- `lead.stage_timeout` — `event_id`, `schema_version`, `timed_out_stage` + `new_stage` present
- `lead.archived` — `event_id`, `schema_version`, `lead_id`, `location_id`, `pipeline` present

---

## 12. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Stage config | Hardcoded TypeScript | 3 fixed pipelines — no misconfiguration risk, no admin UI needed, changes tracked in git |
| Cache sync | Event-driven (EventBridge) | No coupling between Pipeline Engine and Lead Service; consistent with platform patterns |
| Timeout enforcement | `croner` polling (15 min) | No Redis/BullMQ needed; 15-min latency is acceptable for stage timeouts measured in days |
| Transition triggers | REST only via CRM API Gateway | Single RBAC choke point; no EventBridge subscription complexity |
| Coordinator override | `override: true` flag | Automation stays strict; humans retain flexibility for edge cases |
| Pipeline conversion | Atomic `/convert` endpoint | Single transaction — no window where a lead is enrolled in zero pipelines |
| `new_lead` 2-hour window | UI warning only (no auto-transition) | Auto-moving a fresh lead to Lost after 2h is too aggressive; coordinators need the flexibility |
| Post-commit events | Fire-and-forget after DB commit | DB state is always authoritative; EventBridge failure does not roll back committed transitions |
| Auth | `X-Internal-Api-Key` header | Pipeline Engine is internal-only; shared secret is simpler than JWT for service-to-service trust |
| Knex setup | Direct config (not `@ortho/db`) | `@ortho/db` is for shared utilities; service owns its Knex instance and migration runner |
| Database schema isolation | `searchPath: 'crm_pipeline'` | Unqualified table names; one Knex config change controls all queries |
| Migration naming | Timestamp prefix | Avoids ordering conflicts; matches Knex CLI convention |
| `event_id` location | Top-level `OrthoEvent` envelope field | Consistent with standard event envelope patterns; cleaner than burying in `payload` |
| `correlation_id` | Forward `X-Correlation-Id` header | Enables distributed tracing across services on a single request chain |
| `schema_version` | `'1.0'` on all events | Establishes versioning baseline from the start |
| Cron package | `croner` | Modern TypeScript support; replaces `node-cron` |
| `TIMEOUT_POLL_ENABLED` | Env var flag | Lets integration tests call the poll function directly without cron interference |
| `SELECT ... FOR UPDATE SKIP LOCKED` | `knex.raw(...)` | Knex 3 doesn't expose `skipLocked()` as a fluent modifier; raw SQL is clearer and safer |
| Route prefix | `/pipeline` Fastify plugin | Service's full paths are `/pipeline/memberships`, etc.; matches the CRM API Gateway's routing table |
| Request/response validation | Full TypeBox schemas | Compile-time + runtime safety for all route shapes |
| Test DB isolation | Per-file schema via `beforeAll/afterAll` | Independent test files; no shared state between test suites |
| SKIP LOCKED test | `pg` direct connections | Knex pool abstraction doesn't allow holding a lock across async boundaries; raw `pg` gives fine-grained control |
| Contract tests | `test/contract/` folder | Kept separate from integration tests; clearly communicates intent and makes CI failures easier to diagnose |
| Logging IDs | Bind `{ requestId, leadId, membershipId, locationId }` | All IDs needed for Datadog trace correlation; bound progressively as they become known |
| Poll job log levels | `info` normal, `error` failures, `warn` batch cap | `info` for observability, `error` for Datadog alerting, `warn` for backlog detection |
| Graceful shutdown | `task.stop()` + let batch complete | Ensures no partial batches on deploy; SIGTERM waits for current work to finish |
