# Nurturing Engine — Updated Design Spec

**Date:** 2026-03-30
**Status:** Approved
**Supersedes:** `docs/superpowers/specs/2026-03-25-nurturing-engine-design.md`
**Scope:** Platform-layer Nurturing Engine — time-delayed drip sequence runtime, enrollment lifecycle, unenrollment, A/B testing. Includes the integration design for the "no response in 24hr/72hr → auto SMS follow-up" use case as the primary reference implementation.

> **Changelog from 2026-03-25 spec:** Incorporates all clarifying-question answers from `tasks/prd-questions-nurturing-engine.md`. Key changes: `@platform/sequence-ui` deferred to a later iteration; `@ortho/interpolator` package created fresh in this iteration; safety-net poller implemented in-process (Fastify plugin), not as a separate ECS task; `call_ai` params updated to `{ system_prompt, user_prompt, model }`; `emit_event` DSL fully specified; 422 response for disabled sequence enrollment; multiple concurrent enrollments explicitly allowed; retry count fixed at 5 total attempts; `GET /sequences/:id/stats` response shape defined; `nurturing.step_failed` event payload specified; `unenroll_sequence` automation amendment scoped to type definition only; `@ortho/event-bus` event additions scoped to TypeScript types only; seed data as migration SQL comments.

---

## 1. Overview

The Nurturing Engine is a **platform-layer service** (`apps/platform/nurturing`) that owns time-delayed drip sequences. It is fully generic — it operates on `entity_type` + `entity_id` pairs with an arbitrary `context` object supplied at enrollment time. It has no knowledge of Ortho CRM concepts such as leads, pipeline stages, or coordinators.

**Core responsibilities:**
- Store versioned sequence definitions (steps, delays, active hours, A/B config)
- Enroll entities in sequences; schedule each step as a BullMQ delayed job
- Execute step actions (send SMS, send email, call AI, emit event) at the scheduled time, respecting active hours
- Cancel enrollments on demand (unenroll) or automatically on opt-out
- Ship `@platform/sequence-ui` React component for staff to build and monitor sequences *(deferred — see Section 7)*

**In scope for this iteration:**
- Full Nurturing Engine backend service
- `@ortho/interpolator` package — created fresh in this iteration (field interpolator + active-hours calculator)
- TypeScript type additions to `@ortho/types` for `lead.outbound_sent` and `lead.activity_logged` events
- `unenroll_sequence` action type definition added to `@ortho/types` (implementation deferred)

**Out of scope for this iteration:**
- `@platform/sequence-ui` React component (deferred to a later iteration)
- Full `unenroll_sequence` worker implementation in the Automation Engine (type definition only)
- Publishing implementation for `lead.outbound_sent` and `lead.activity_logged` in their respective services
- Event-driven workflow logic (delegated to Automation Engine)
- Stage timeout scheduling (delegated to Pipeline Engine, which emits `lead.stage_timeout`)
- Branching / conditional routing (belongs in the Automation Engine's event-reactive layer; sequences are linear)

---

## 2. Architecture

```
Automation Engine / Pipeline Engine
        │
        ▼  POST /sequences/enroll
┌──────────────────────────────────────────────┐
│           Nurturing Engine                   │
│   apps/platform/nurturing                    │
│                                              │
│  REST API  ──→  Enrollment Manager           │
│                   │  writes enrollments +    │
│                   │  step_executions to DB   │
│                   ▼                          │
│             BullMQ Step Queue (Redis)        │
│             (one delayed job per step)       │
│                   │                          │
│             Step Worker                      │
│             (guard checks → active hours     │
│              → execute action)               │
│                   │                          │
│             Action Executor                  │
│  ┌────────────┬───────────┬───────────────┐  │
│  send_message send_email call_ai emit_event  │
└──────────────────────────────────────────────┘
        │           │          │         │
  Messaging    Email Svc   AI Svc   EventBridge
  Service
```

Also subscribes to EventBridge (`opt_out.received` via a **dedicated SQS queue** — one queue per service, standard EventBridge fan-out) to automatically unenroll opted-out entities.

**Key architectural decisions:**

- **BullMQ delayed jobs for scheduling** — each step is enqueued with `delay = scheduled_at - now()`. No cron polling loop. Naturally handles delays from minutes to weeks.
- **`job_id` stored on each step row** — after BullMQ enqueues a job, the returned `job_id` is written back to `sequence_step_executions.job_id`. This allows the safety-net poller to distinguish "never enqueued" steps (job_id IS NULL) from "enqueued but delayed" steps, preventing spurious re-enqueuing.
- **Step worker uses optimistic lock on status transition** — `UPDATE sequence_step_executions SET status = 'running' WHERE id = ? AND status = 'pending' RETURNING id`. If no row is returned, another worker already claimed the step; exit cleanly.
- **Active hours deferral updates `scheduled_at` and `job_id`** — when a step is deferred, the worker updates `scheduled_at` to the new execution time and stores the new `job_id` before re-enqueueing. This keeps the safety-net poller accurate.
- **Sequence DSL mirrors the Automation Engine's versioning model** — `sequence_definitions` group table + `sequence_versions` history table, same active/draft/disabled lifecycle.
- **Context snapshot at enrollment time** — the `context` object passed at `POST /sequences/enroll` is stored on the enrollment row and used for all step executions. The Nurturing Engine never re-fetches entity data mid-sequence.
- **Sequences are linear** — no branch nodes. Conditional routing between sequences is the Automation Engine's responsibility (it decides which sequence to enroll the entity in based on event conditions).
- **Safety-net poller runs in-process** — implemented as a Fastify startup hook / plugin within the REST API process, not a separate ECS Scheduled Task. Fires every 5 minutes via `setInterval`. This eliminates the operational overhead of a second ECS task definition for a low-frequency recovery job.

---

## 3. Sequence DSL

Sequences are stored as versioned JSON in the `platform_nurturing` schema. The engine is a generic interpreter — product concepts are absent.

### 3.1 Full Sequence Definition Example

```json
{
  "id": "uuid",
  "name": "Contacted — No Response Follow-up",
  "version": 2,
  "enabled": true,

  "active_hours": {
    "start": "08:00",
    "end": "20:00",
    "timezone_field": "context.location_timezone"
  },

  "cancel_on_opt_out": true,

  "steps": [
    {
      "id": "step-1",
      "delay": { "value": 24, "unit": "hours" },
      "action": {
        "type": "send_message",
        "params": {
          "template_id": "contacted-followup-sms-1",
          "to_field": "context.phone",
          "from_field": "context.location_number",
          "context": "context",
          "dedup_key": "{{enrollment_id}}-step-1"
        }
      },
      "ab_variant_override": {
        "B": {
          "template_id": "contacted-followup-sms-1-variant-b"
        }
      }
    },
    {
      "id": "step-2",
      "delay": { "value": 72, "unit": "hours" },
      "action": {
        "type": "send_message",
        "params": {
          "template_id": "contacted-followup-sms-2",
          "to_field": "context.phone",
          "from_field": "context.location_number",
          "context": "context",
          "dedup_key": "{{enrollment_id}}-step-2"
        }
      }
    }
  ],

  "ab_test": {
    "enabled": true,
    "split": { "A": 50, "B": 50 },
    "tracked_event": "lead.stage_changed",
    "tracked_condition": {
      "field": "payload.new_stage",
      "op": "eq",
      "value": "exam_scheduled"
    }
  }
}
```

> **Note on A/B tracking:** The `tracked_event` and `tracked_condition` fields are entirely generic — the Nurturing Engine records a conversion when any event matching the condition arrives for the enrolled entity. The example values (`lead.stage_changed`, `exam_scheduled`) are Ortho CRM-specific, but the engine itself has no knowledge of what these values mean. Any product deploying the Nurturing Engine supplies its own event type and condition.

### 3.2 DSL Rules

**Delays are always from enrollment time, not from the previous step.** In the example above, step-1 fires at `enrolled_at + 24h` and step-2 fires at `enrolled_at + 72h`. These are the initial `scheduled_at` values. If step-1 is deferred by active hours, step-2's `scheduled_at` is unaffected — it remains `enrolled_at + 72h`. If step-1 itself is deferred, the step worker updates that step's own `scheduled_at` to the actual execution time; step-2 is never touched.

**`active_hours` is sequence-level.** It applies only to `send_message` and `send_email` action types. `emit_event` and `call_ai` execute immediately regardless of active hours. The `timezone_field` is a dot-notation path resolved against the enrollment `context` object.

**`active_hours.start` and `active_hours.end` are time-of-day values only (`HH:MM`, 24-hour).** There is no day-of-week constraint. The window applies every day. The active hours calculator computes the delay-until timestamp as the next occurrence of `start` time in the resolved timezone, always within the next 24 hours.

**`ab_variant_override`** — a step can declare param overrides per variant. Only the listed fields are overridden; the rest inherit from the base `params`. Variant assignment happens once at enrollment time, is stored on the enrollment row, and applies to all steps uniformly.

**`dedup_key` uses `{{enrollment_id}}`** — not an event ID, since step workers operate without access to the original triggering event. The enrollment ID is the idempotency anchor for all outbound calls from this sequence.

### 3.3 Field Interpolation

Implemented in `@ortho/interpolator` — created fresh in this iteration (both field interpolator and active-hours calculator):

- **Dot-notation path** (`"context.phone"`) — resolved against the enrollment `context` object.
- **Template string** (`"{{enrollment_id}}-step-1"`) — resolved against execution context: `enrollment_id`, `step_id`, `entity_type`, `entity_id`.

A value matching neither form is used as a literal string.

### 3.4 Action Types

| Type | Description | Respects `active_hours` |
|---|---|---|
| `send_message` | SMS/MMS — worker calls `POST /templates/render` first (with `template_id` + enrollment context), then passes the pre-rendered body to Messaging Service `POST /messages/send`. Messaging Service never calls Template Service. | Yes |
| `send_email` | Email — worker calls `POST /templates/render` first (with `template_id` + enrollment context), then passes the pre-rendered `subject` + `body_html` + `body_text` to Email Service `POST /emails/send`. Email Service never calls Template Service. | Yes |
| `call_ai` | Generate AI draft via AI Service (`POST /ai/complete`). Params: `{ system_prompt, user_prompt, model }` — both prompt fields are template strings resolved via `@ortho/interpolator` against the enrollment context. Output stored in `step_executions.output`. When `auto_send: false` (default), the step completes and the Nurturing Engine publishes `nurturing.step_output_ready` carrying `enrollment_id`, `step_id`, `entity_type`, `entity_id`. The **Conversation Service** subscribes (via its own dedicated SQS queue), then pushes a real-time alert to the coordinator's browser via the Notification Service WebSocket. The coordinator UI then polls `GET /sequences/:id/enrollments/:eid/steps/:sid/output` to retrieve the draft. When `auto_send: true` (requires explicit manager config), the worker chains immediately into a `send_message` call using the AI output as the message body. | No |
| `emit_event` | Publish event to EventBridge. Primary mechanism for product-layer side effects without importing product types. | No |

No `branch` node (branching belongs in the Automation Engine), no `enroll_sequence` node (no recursive enrollment), no `call_webhook` node (reserved for Automation Engine).

#### `emit_event` Step DSL

```json
{
  "id": "step-3",
  "delay": { "value": 7, "unit": "days" },
  "action": {
    "type": "emit_event",
    "params": {
      "event_type": "nurturing.no_response_escalation",
      "payload": {
        "entity_id": "context.entity_id",
        "stage": "context.stage",
        "escalation_level": "final"
      },
      "include_context": true
    }
  }
}
```

**`emit_event` DSL rules:**
- `payload` — object with field interpolation applied to all values (dot-notation paths resolved against enrollment context; template strings resolved against execution context).
- `include_context: true` (optional, default `false`) — when true, the full enrollment `context` object is shallow-merged into `payload` before publishing. Fields explicitly set in `payload` take precedence over context keys with the same name.
- `event_type` — literal string (no interpolation); required.

#### `call_ai` Step DSL Example

```json
{
  "id": "step-ai",
  "delay": { "value": 1, "unit": "hours" },
  "action": {
    "type": "call_ai",
    "params": {
      "system_prompt": "You are a helpful orthodontic practice assistant.",
      "user_prompt": "Draft a follow-up SMS for a lead named {{context.first_name}} who has not responded in 24 hours. Keep it under 160 characters.",
      "model": "claude-haiku-4-5-20251001",
      "auto_send": false
    }
  }
}
```

### 3.5 Versioning

Same model as the Automation Engine:
- `sequence_definitions` is a group (name + status + pointer to `active_version`).
- All versioned definitions live in `sequence_versions`.
- Editing a sequence inserts a new version row and increments `current_version`; `active_version` stays unchanged until a manager explicitly activates.
- The Enrollment Manager records the active version number at enrollment time (`sequence_version` column). Step workers load step params from `sequence_versions` by `(sequence_id, sequence_version)` — not from the live active version. In-progress step executions always use the params from the version active at enrollment.

---

## 4. Database Schema — `platform_nurturing`

```sql
-- Sequence definition group: name, status, active version pointer
sequence_definitions (
  id               uuid PRIMARY KEY,
  name             text NOT NULL,
  status           text NOT NULL DEFAULT 'draft',  -- draft|active|disabled
  active_version   integer,                         -- NULL until first activation
  current_version  integer NOT NULL DEFAULT 1,
  created_by       uuid,
  created_at       timestamptz,
  updated_at       timestamptz
)

-- One row per version of a sequence definition
sequence_versions (
  id                uuid PRIMARY KEY,
  sequence_id       uuid REFERENCES sequence_definitions NOT NULL,
  version           integer NOT NULL,
  active_hours      jsonb,
  cancel_on_opt_out boolean NOT NULL DEFAULT true,
  steps             jsonb NOT NULL,                 -- ordered array of step definitions
  ab_test           jsonb,                          -- null if A/B disabled
  created_by        uuid,
  created_at        timestamptz,
  UNIQUE (sequence_id, version)
)

-- One row per entity enrollment in a sequence
sequence_enrollments (
  id                uuid PRIMARY KEY,
  sequence_id       uuid REFERENCES sequence_definitions NOT NULL,
  sequence_version  integer NOT NULL,               -- version active at enrollment time
  entity_type       text NOT NULL,
  entity_id         text NOT NULL,
  context           jsonb NOT NULL,                 -- snapshot at enrollment time
  ab_variant        text,                           -- 'A' | 'B' | null
  status            text NOT NULL DEFAULT 'active', -- active|completed|unenrolled|failed
  enrolled_at       timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  dedup_key         text NOT NULL UNIQUE            -- caller-supplied idempotency key
)

-- One row per step per enrollment, pre-inserted at enrollment time
sequence_step_executions (
  id             uuid PRIMARY KEY,
  enrollment_id  uuid REFERENCES sequence_enrollments NOT NULL,
  step_id        text NOT NULL,                     -- references step.id in version JSON
  step_index     integer NOT NULL,
  scheduled_at   timestamptz NOT NULL,              -- enrolled_at + step.delay; updated on active hours deferral
  job_id         text,                              -- BullMQ job ID; NULL until enqueued; updated on deferral
  status         text NOT NULL DEFAULT 'pending',   -- pending|running|completed|failed|cancelled
  attempt        integer NOT NULL DEFAULT 0,
  output         jsonb,
  error          text,
  started_at     timestamptz,
  completed_at   timestamptz
)
```

**Indexes:**
```sql
-- sequence_enrollments
CREATE INDEX ON sequence_enrollments (entity_id, status);
CREATE INDEX ON sequence_enrollments (sequence_id, entity_type, entity_id, status);

-- sequence_step_executions
CREATE INDEX ON sequence_step_executions (enrollment_id, status);
CREATE INDEX ON sequence_step_executions (enrollment_id, step_id);
CREATE INDEX ON sequence_step_executions (scheduled_at, status) WHERE status = 'pending';
```

**`sequence_step_executions` rows are pre-inserted at enrollment time** — all steps are written upfront with `scheduled_at` computed from `enrolled_at + delay`. This gives a complete audit trail immediately and lets unenrollment cancel all pending steps in a single `UPDATE` without re-parsing the sequence definition.

**`job_id` on `sequence_step_executions`** — written after BullMQ enqueues the job. The safety-net poller uses `job_id IS NULL` (combined with `scheduled_at < now() - 1 minute`) to identify steps that were persisted to DB but never enqueued (crash between DB commit and BullMQ enqueue). Steps with a future `scheduled_at` and `job_id IS NULL` are also re-enqueued by a startup scan (see Section 5.5).

**`dedup_key` on `sequence_enrollments` is caller-supplied.** For the no-response use case, the Automation Engine passes `"{{event_id}}-no-response"` — unique per triggering event. Re-entry to Contacted (after Lost) generates a new `lead.outbound_sent` event with a new `event_id`, so a fresh enrollment is created automatically.

**`dedup_key` idempotency applies regardless of prior enrollment status.** If a row with the given `dedup_key` already exists — whether `active`, `completed`, or `unenrolled` — the enroll call returns `200 OK` and makes no changes. Re-enrollment after a prior completed or unenrolled cycle requires a semantically distinct `dedup_key` (e.g. a new event's `event_id`). Callers must design their dedup keys with this in mind.

**Multiple concurrent enrollments** — the same entity may have multiple active enrollments in the same sequence simultaneously, provided each uses a distinct `dedup_key`. There is no system-level constraint preventing `(sequence_id, entity_id)` from appearing more than once in `active` status. Callers are responsible for designing `dedup_key` logic that reflects their intent.

---

## 5. Execution Flow

### 5.1 Enrollment

`POST /sequences/enroll` receives `{ sequence_id, entity_type, entity_id, context, dedup_key }`.

1. Check `dedup_key` uniqueness — if already exists, return `200 OK` (idempotent, no changes).
2. Load `sequence_definitions` where `id = sequence_id`.
   - If `status = 'disabled'`: return `422 Unprocessable Entity` with `{ "error": "sequence_disabled" }`.
   - If `status = 'draft'` (no `active_version`): return `422` with `{ "error": "sequence_not_active" }`.
3. Load `active_version` row from `sequence_versions`.
4. Assign A/B variant if `ab_test.enabled = true` — weighted random pick stored on enrollment row.
5. In a single DB transaction:
   - `INSERT sequence_enrollments` (status: `active`), storing `sequence_version`, context snapshot, and variant.
   - For each step: `INSERT sequence_step_executions` with `scheduled_at = enrolled_at + step.delay`, `job_id = NULL`.
6. After transaction commits: for each step, enqueue a BullMQ delayed job, then `UPDATE sequence_step_executions SET job_id = ? WHERE id = ?`. If the process crashes between commit and BullMQ enqueue, steps remain with `job_id = NULL` and are recovered by startup scan or safety-net poller (Section 5.5).
7. Return `201` with `enrollment_id`.

### 5.2 Step Execution (Happy Path)

```
BullMQ fires delayed job (enrollment_id, step_id)
  │
  ▼
Step Worker loads enrollment row
  │
  ├─ enrollment.status ≠ 'active'?
  │     → mark step 'cancelled', ACK job, stop
  │
  ▼
Optimistic lock: UPDATE step_executions SET status='running', started_at=now()
                 WHERE id=? AND status='pending' RETURNING id
  │
  ├─ No row returned → step already claimed by another worker, ACK job, stop
  │
  ▼
Load step definition from sequence_versions (by enrollment.sequence_version + step_id)
  │
  ▼
Resolve action params via field interpolator
(dot-notation paths against enrollment.context;
 template strings against {enrollment_id, step_id, entity_id})
  │
  ▼
Apply A/B variant overrides to params (if enrollment.ab_variant = 'B' and step has ab_variant_override.B)
  │
  ▼
Active hours check (send_message / send_email only)
  ├─ Inside window → proceed
  └─ Outside window → compute ms until next window open (≤ 24h)
                       UPDATE step_executions SET scheduled_at=<new_time>, status='pending', job_id=NULL
                       Enqueue new BullMQ delayed job
                       UPDATE step_executions SET job_id=<new_job_id>
                       ACK original job, stop
  │
  ▼
Execute action (HTTP call to platform service)
  │
  ├─ Success → mark step 'completed', store output if applicable
  │             if action type is 'call_ai' and auto_send=false:
  │               publish nurturing.step_output_ready { enrollment_id, step_id, entity_type, entity_id }
  │             if last step → mark enrollment 'completed'
  │                            publish nurturing.enrollment_completed
  │
  └─ Failure → BullMQ retry with exponential backoff: 5s → 30s → 2m → 10m
                5 total attempts (1 initial + 4 retries)
                max retries exhausted → step 'failed', enrollment 'failed'
                publish nurturing.step_failed
                Datadog alert fires
```

### 5.3 Unenrollment

`POST /sequences/unenroll` receives `{ sequence_id, entity_type, entity_id }`.

The endpoint matches by `(sequence_id, entity_type, entity_id, status = 'active')` — callers do not need to know the `enrollment_id`. Including `entity_type` in the match prevents a collision between different entity types that happen to share the same `entity_id` string.

1. Find `sequence_enrollments` where `sequence_id + entity_type + entity_id + status = 'active'`. If none, return `200` (idempotent no-op).
2. In a single transaction: set enrollment `status = 'unenrolled'`; `UPDATE sequence_step_executions SET status = 'cancelled' WHERE enrollment_id = ? AND status = 'pending'`.
3. Best-effort BullMQ job removal for cancelled steps using stored `job_id` values (`job.remove()` — succeeds if the job hasn't been picked up yet). Jobs already in a worker proceed to the optimistic lock check (which fails since status is now `cancelled`) and exit cleanly.
4. Publish `nurturing.enrollment_unenrolled` to EventBridge.
5. Return `200`.

### 5.4 Opt-Out Handler

EventBridge → dedicated SQS queue → Nurturing Engine consumer receives `opt_out.received`:

1. Extract `entity_id` from event payload.
2. `SELECT` all active enrollments for `entity_id` (across all sequences).
3. For each enrollment: run unenrollment flow (Section 5.3).
4. Publish `nurturing.all_sequences_cancelled` to EventBridge (Lead Service subscribes → sets opt-out flag on lead record).

### 5.5 Safety-Net Recovery

**Startup scan** — on service startup, scan asynchronously for steps with `job_id IS NULL AND status = 'pending'`. These had their DB rows committed but BullMQ jobs never enqueued (crash between step 5 and 6 in Section 5.1). Re-enqueue each, then update `job_id`. **The server starts accepting HTTP traffic immediately — the startup scan runs in the background and does not block server readiness.**

**In-process safety-net poller** — implemented as a Fastify plugin registered at startup. Uses `setInterval` at 5-minute intervals. Finds steps whose BullMQ jobs were lost after initial enqueue:

```sql
SELECT * FROM sequence_step_executions
WHERE status = 'pending'
  AND scheduled_at < now() - interval '1 minute'
  AND job_id IS NOT NULL   -- was enqueued, but job disappeared (Redis failure)
```

Re-enqueue each. The optimistic lock (`WHERE status = 'pending'`) prevents double execution if the original job reappears after Redis recovery. Maximum recovery latency is 6 minutes (5-minute poll interval + 1-minute grace period). This is acceptable for customer-facing SMS follow-ups; tune the poll interval if a tighter SLA is needed.

> **Deployment note:** The poller runs inside the REST API ECS task — not as a separate ECS Scheduled Task. Only one running REST API instance should be elected as poller to avoid duplicate re-enqueues. Use a Redis lock (e.g. BullMQ's built-in `Scheduler` or a simple `SET NX EX`) to ensure only one instance runs the poll cycle at a time.

---

## 6. API Surface

The Nurturing Engine exposes a REST API consumed by: the Automation Engine (enroll/unenroll), the `@platform/sequence-ui` component (sequence CRUD, enrollment log), and the Reporting Service (analytics queries).

```
# Sequence management
GET    /sequences                         — list all (name, status, version, step count)
POST   /sequences                         — create sequence (inserts version 1 as draft)
GET    /sequences/:id                     — get with active + current version detail
PUT    /sequences/:id                     — save draft (new version row, bumps current_version)
POST   /sequences/:id/activate            — activate current_version (marketing_manager only)
POST   /sequences/:id/disable             — disable (marketing_manager only)

# Enrollment operations (service-to-service and UI)
POST   /sequences/enroll                  — body: { sequence_id, entity_type, entity_id, context, dedup_key }
POST   /sequences/unenroll                — body: { sequence_id, entity_type, entity_id }
GET    /sequences/:id/enrollments         — list enrollments (status, variant, enrolled_at)
GET    /sequences/:id/enrollments/:eid    — detail with all step statuses + outputs

# Step output (for call_ai steps — coordinator review)
GET    /sequences/:id/enrollments/:eid/steps/:sid/output  — retrieve AI draft or step result

# Analytics
GET    /sequences/:id/stats               — completion rate, unenrollment rate, A/B conversion rates
```

**Auth:** Identity Service JWT. Activate/disable require `marketing_manager` role. Draft create/edit allowed for `marketing_staff`. Enroll/unenroll use a service JWT (Automation Engine, not a user token).

**Pagination:** all list endpoints accept `limit` + `cursor` (keyset on `created_at`).

### 6.1 `GET /sequences/:id/stats` Response Shape

```json
{
  "sequence_id": "uuid",
  "total_enrollments": 350,
  "completed_count": 210,
  "unenrolled_count": 100,
  "failed_count": 5,
  "active_count": 35,
  "completion_rate": 0.60,
  "unenrollment_rate": 0.286,
  "ab": {
    "A": {
      "enrollments": 175,
      "completions": 110,
      "completion_rate": 0.629,
      "conversion_count": 42,
      "conversion_rate": 0.24
    },
    "B": {
      "enrollments": 175,
      "completions": 100,
      "completion_rate": 0.571,
      "conversion_count": 31,
      "conversion_rate": 0.177
    },
    "winner": "A",
    "significant": true,
    "p_value": 0.031
  }
}
```

**Statistical significance:** computed using a **two-proportion z-test** comparing `conversion_rate` between variants. `significant = true` when p < 0.05 AND both variants have ≥ 100 enrollments. `winner` is set to the variant with the higher `conversion_rate` when `significant = true`; `null` otherwise. `ab` key is `null` when the sequence has no A/B test configured.

### 6.2 Enrollment Validation Error Responses

| Condition | Status | Body |
|---|---|---|
| `dedup_key` already exists | `200 OK` | `{ "enrollment_id": "<existing_id>", "idempotent": true }` |
| Sequence `status = 'disabled'` | `422 Unprocessable Entity` | `{ "error": "sequence_disabled" }` |
| Sequence `status = 'draft'` (no active version) | `422 Unprocessable Entity` | `{ "error": "sequence_not_active" }` |
| Sequence not found | `404 Not Found` | `{ "error": "sequence_not_found" }` |

---

## 7. `@platform/sequence-ui` React Component

> **Deferred — not in scope for this iteration.** The backend service and all APIs are implemented; the React component package is built in a subsequent iteration.

When implemented, this component will be exported from `packages/@platform/sequence-ui` and will call the Nurturing Engine API directly from the browser (not proxied through CRM API Gateway). Auth via the same Identity Service JWT the CRM shell holds.

**Template picker design decision (Q16):** when the Sequence Builder's step editor renders a template picker, it calls the Template Service **through the CRM API Gateway** (not directly from the browser). This keeps the React component from having hardcoded knowledge of the Template Service URL and keeps auth routing consistent.

**Planned views:**

**Sequence List** — table: name, trigger label (informational, set by product config), step count, A/B status, current version, status badge (Draft / Active / Disabled).

**Sequence Builder:**
- Step list — vertical ordered list. Each step shows delay, action type, template. Drag to reorder. Add/remove steps.
- Step editor panel — delay input (value + unit: minutes / hours / days), action type selector, template picker (calls Template Service via CRM API Gateway), A/B variant toggle with traffic split slider and conversion event config.
- Active hours config — start/end time inputs + timezone field selector.
- Save Draft / Activate buttons. Activate requires `marketing_manager` role — button hidden for `marketing_staff`.

**Enrollment Log** — table: entity ID, enrolled at, variant, status, per-step status badges. Expandable row shows step detail, output, attempt count, errors. Filterable by status and date range.

**A/B Results panel** — shown when `ab_test.enabled = true`: variant A vs B enrollment count, completion rate, and conversion rate. Auto-declares a winner when statistical significance is reached (two-proportion z-test, p < 0.05, minimum 100 enrollments per variant).

### Sequence States

| State | Description |
|---|---|
| Draft | Editable, not running. `active_version` is NULL or points to a previous version. |
| Active | Running live. Editing inserts a new `sequence_versions` row; `active_version` unchanged until manager activates. |
| Disabled | Paused. No new enrollments accepted. In-progress enrollments complete normally. |

Only Marketing Managers can activate or disable sequences. Marketing Staff can create and edit drafts.

---

## 8. Integration: No-Response Follow-up Use Case

This section documents the Automation Engine rules and new domain events that implement the Contacted stage feature: "If no response in 24hrs: auto SMS follow-up 1. If no response in 72hrs: auto SMS follow-up 2."

### 8.1 New Domain Events

> **`@ortho/types` amendment required:** Both events below (`lead.outbound_sent`, `lead.activity_logged`) are absent from the platform architecture event table (`docs/01-platform-arch-design.md`, Section 3.1) and from the `@ortho/event-bus` schema package. **This iteration adds the TypeScript type definitions to `@ortho/types` only.** The publishing implementations (Conversation Service publishing `lead.outbound_sent`, Lead Service publishing `lead.activity_logged`) are delivered in those services' respective implementation iterations.

**`lead.outbound_sent`** — published by Conversation Service for each outbound coordinator message. `is_first_in_stage` is computed by the Conversation Service by checking whether any prior outbound message exists for this `entity_id` since `stage_entered_at`. **`stage_entered_at` is fetched from the Lead Service DB via `GET /leads/:id`** — it is stored on the lead record and retrieved by the Conversation Service via API call at the time the outbound message is logged.

```json
{
  "event_type": "lead.outbound_sent",
  "entity_type": "lead",
  "entity_id": "<lead_id>",
  "payload": {
    "phone": "+15551234567",
    "email": "jane@example.com",
    "location_number": "+15559999999",
    "location_timezone": "America/New_York",
    "stage": "contacted",
    "stage_entered_at": "2026-03-25T14:00:00Z",
    "is_first_in_stage": true,
    "sent_by": "<coordinator_user_id>",
    "sent_at": "2026-03-25T14:05:00Z"
  }
}
```

**`lead.activity_logged`** — published by Lead Service when a coordinator explicitly logs a call disposition or manual note. Does **not** fire on automated system events (field updates, CSV import rows, stage changes). The distinction is: if a human coordinator takes a deliberate action to record contact with the lead, this event fires.

```json
{
  "event_type": "lead.activity_logged",
  "entity_type": "lead",
  "entity_id": "<lead_id>",
  "payload": {
    "activity_type": "call_logged",
    "stage": "contacted",
    "logged_by": "<coordinator_user_id>",
    "logged_at": "2026-03-25T15:30:00Z"
  }
}
```

### 8.2 Automation Engine Amendment: `unenroll_sequence` Action

The no-response follow-up feature requires a new action type in the Automation Engine: `unenroll_sequence`. **This iteration adds the action type definition to `@ortho/types` only** — the full worker implementation (`unenroll-sequence.worker.ts`) is deferred to the Automation Engine's own implementation iteration. Specifically, this iteration delivers:
- `unenroll_sequence` action type added to `@ortho/types` action type union
- `unenroll_sequence` entry in the Automation Engine spec action types table (Section 6 of `2026-03-24-automation-engine-design.md`) as a documentation amendment

The full worker implementation and contract test for `POST /sequences/unenroll` are deferred.

The action calls `POST /sequences/unenroll` on the Nurturing Engine. Executes immediately, ignores `active_hours`. Idempotent by design — the endpoint matches by `(sequence_id, entity_type, entity_id, status='active')` and returns `200` when no active enrollment is found, so no `dedup_key` is needed.

```json
{
  "type": "unenroll_sequence",
  "params": {
    "sequence_id": "<uuid-of-contacted-no-response-sequence>",
    "entity_type": "payload.entity_type",
    "entity_id": "payload.entity_id"
  }
}
```

### 8.3 Automation Engine Rules

**Rule 1 — Enroll on first outbound contact**

Trigger: `lead.outbound_sent` with `is_first_in_stage = true` and `stage = contacted`. The enrollment `dedup_key` is `"{{event_id}}-no-response"` — unique per event. Re-entry to Contacted (after Lost) generates a new `lead.outbound_sent` event with a new `event_id`, producing a fresh dedup_key and a fresh enrollment. Duplicate EventBridge deliveries of the same event are blocked by the Automation Engine's own `(event_id, rule_id)` idempotency check before `enroll_sequence` is ever called.

```json
{
  "name": "No-Response Follow-up — Enroll",
  "trigger": { "event_type": "lead.outbound_sent" },
  "condition": {
    "op": "AND",
    "conditions": [
      { "field": "payload.stage", "op": "eq", "value": "contacted" },
      { "field": "payload.is_first_in_stage", "op": "eq", "value": true }
    ]
  },
  "action_tree": {
    "type": "enroll_sequence",
    "params": {
      "sequence_id": "<uuid>",
      "entity_type": "lead",
      "entity_id": "payload.entity_id",
      "context": "payload",
      "dedup_key": "{{event_id}}-no-response"
    }
  }
}
```

**Rule 2 — Cancel on inbound SMS**

No stage condition needed — `unenroll_sequence` is idempotent; if the entity is not currently enrolled in this sequence, the call is a no-op.

```json
{
  "name": "No-Response Follow-up — Cancel on Inbound SMS",
  "trigger": { "event_type": "message.received" },
  "action_tree": {
    "type": "unenroll_sequence",
    "params": {
      "sequence_id": "<uuid>",
      "entity_type": "payload.entity_type",
      "entity_id": "payload.entity_id"
    }
  }
}
```

**Rule 3 — Cancel on activity logged**

Scoped to the contacted stage to avoid premature unenrollment triggered by activity in other stages.

```json
{
  "name": "No-Response Follow-up — Cancel on Activity",
  "trigger": { "event_type": "lead.activity_logged" },
  "condition": {
    "field": "payload.stage", "op": "eq", "value": "contacted"
  },
  "action_tree": {
    "type": "unenroll_sequence",
    "params": {
      "sequence_id": "<uuid>",
      "entity_type": "payload.entity_type",
      "entity_id": "payload.entity_id"
    }
  }
}
```

**Rule 4 — Cancel on stage change away from Contacted**

```json
{
  "name": "No-Response Follow-up — Cancel on Stage Change",
  "trigger": { "event_type": "lead.stage_changed" },
  "condition": {
    "field": "payload.from_stage", "op": "eq", "value": "contacted"
  },
  "action_tree": {
    "type": "unenroll_sequence",
    "params": {
      "sequence_id": "<uuid>",
      "entity_type": "payload.entity_type",
      "entity_id": "payload.entity_id"
    }
  }
}
```

**Rule 5 — Cancel on manual coordinator outbound (configurable, disabled by default)**

Marketing managers enable this per their preference via `@platform/automation-ui`.

```json
{
  "name": "No-Response Follow-up — Cancel on Manual Send",
  "enabled": false,
  "trigger": { "event_type": "lead.outbound_sent" },
  "condition": {
    "op": "AND",
    "conditions": [
      { "field": "payload.stage", "op": "eq", "value": "contacted" },
      { "field": "payload.is_first_in_stage", "op": "eq", "value": false }
    ]
  },
  "action_tree": {
    "type": "unenroll_sequence",
    "params": {
      "sequence_id": "<uuid>",
      "entity_type": "payload.entity_type",
      "entity_id": "payload.entity_id"
    }
  }
}
```

---

## 9. Infrastructure & Service Layout

```
apps/platform/nurturing/
├── src/
│   ├── routes/
│   │   ├── sequences.ts              # sequence CRUD, activate, disable
│   │   ├── enrollments.ts            # enroll, unenroll, enrollment log, step output
│   │   └── stats.ts                  # A/B results, completion rates
│   ├── services/
│   │   ├── enrollment-manager.ts     # enroll + pre-insert steps + enqueue BullMQ jobs
│   │   ├── unenrollment.ts           # cancel enrollment + pending steps + BullMQ removal
│   │   ├── step-worker.ts            # BullMQ worker: guard checks → active hours → execute
│   │   ├── action-executor.ts        # dispatches to action-specific handlers
│   │   ├── ab-assigner.ts            # weighted random variant assignment
│   │   ├── safety-net-poller.ts      # Fastify plugin: every 5min re-enqueue orphaned steps (Redis-locked)
│   │   ├── startup-scanner.ts        # async background scan on startup: re-enqueue job_id=NULL steps
│   │   └── action-handlers/
│   │       ├── send-message.ts
│   │       ├── send-email.ts
│   │       ├── call-ai.ts
│   │       └── emit-event.ts
│   ├── consumers/
│   │   └── opt-out.consumer.ts       # SQS consumer for opt_out.received (dedicated queue)
│   ├── repositories/
│   │   ├── sequence-definitions.repo.ts
│   │   ├── sequence-versions.repo.ts
│   │   ├── enrollments.repo.ts
│   │   └── step-executions.repo.ts
│   ├── events/
│   │   └── publisher.ts              # publishes nurturing.* events to EventBridge
│   └── index.ts
├── migrations/
│   └── 001_initial_schema.ts         # includes SQL snippet comment for bootstrap sequence seed
├── test/
├── Dockerfile
├── package.json
└── tsconfig.json
```

**Shared code:** `@ortho/interpolator` — created fresh in this iteration. Exports `interpolateFields(template, context)` (field interpolator) and `computeNextActiveWindowMs(activeHours, timezone)` (active-hours calculator). Used by both the Nurturing Engine and the Automation Engine to prevent logic divergence.

**Scaling:** The step worker runs as a separate ECS task definition from the REST API — same Docker image, different entry points (`index.ts` for the REST API, `worker.ts` for the BullMQ worker). This allows the worker to scale independently under high enrollment volume.

**Opt-out SQS queue:** The Nurturing Engine has its own dedicated SQS queue subscribed to `opt_out.received` from EventBridge. It does not share a queue with the Automation Engine or any other subscriber. Standard EventBridge fan-out — each subscriber gets an independent copy of the event.

**Bootstrap sequence seed:** The initial migration file (`001_initial_schema.ts`) includes a SQL snippet in the migration comments documenting a complete `INSERT` for the "Contacted — No Response Follow-up" sequence definition in `draft` status. Operators can copy and execute it to bootstrap the sequence without manual UI entry. The migration itself does **not** execute the insert automatically.

**Runtime dependencies:**

| Dependency | Purpose |
|---|---|
| PostgreSQL (`platform_nurturing` schema) | Sequence definitions, enrollments, step executions |
| Redis / ElastiCache | BullMQ delayed job queue + safety-net poller distributed lock |
| AWS SQS (dedicated queue) | EventBridge subscription for `opt_out.received` |
| Template Service | `send_message` + `send_email` action handlers — `POST /templates/render` called first to get pre-rendered body |
| Messaging Service | `send_message` action handler — receives pre-rendered body from worker |
| Email Service | `send_email` action handler — receives pre-rendered subject + body from worker |
| AI Service | `call_ai` action handler |
| AWS EventBridge | `emit_event` action + publishing `nurturing.*` events |

**Events published by the Nurturing Engine:**

| Event | Trigger | Payload | Subscribers |
|---|---|---|---|
| `nurturing.enrollment_completed` | All steps completed | `{ enrollment_id, sequence_id, entity_type, entity_id }` | Analytics |
| `nurturing.enrollment_unenrolled` | Explicit unenroll call | `{ enrollment_id, sequence_id, entity_type, entity_id }` | Analytics |
| `nurturing.step_failed` | Step hits max retries (5 attempts) | `{ enrollment_id, step_id, entity_type, entity_id, sequence_id, error, attempt_count, scheduled_at }` | Analytics, Datadog alert |
| `nurturing.step_output_ready` | `call_ai` step with `auto_send: false` | `{ enrollment_id, step_id, entity_type, entity_id }` | Conversation Service → Notification Service WebSocket → coordinator browser polls output endpoint |
| `nurturing.all_sequences_cancelled` | Opt-out received | `{ entity_id, entity_type, cancelled_enrollment_ids: [] }` | Lead Service |

---

## 10. Testing Strategy

### Unit Tests (Vitest, no external dependencies)

- **`@ortho/interpolator` — field interpolator** — dot-notation resolution, template strings, missing fields, nested objects (shared with Automation Engine; tested once in shared package)
- **`@ortho/interpolator` — active hours** — window boundary cases, DST edge cases, delay always ≤ 24h, time-of-day-only constraint
- **`ab-assigner`** — 50/50 split converges within margin over 10,000 samples; 0/100 always assigns to the configured variant
- **`enrollment-manager`** — correct `scheduled_at` per step delay, correct step pre-insertion count, dedup rejection path
- **`unenrollment`** — marks all pending steps `cancelled`, leaves non-pending steps untouched; idempotent on missing enrollment
- **`stats` service** — two-proportion z-test: correct p-value computation, `significant = true` only when p < 0.05 AND both variants ≥ 100 enrollments, `winner` null when not significant

### Integration Tests (Vitest + real Postgres + real Redis, platform service calls mocked via HTTP interceptor)

- Enroll → all steps pre-inserted with correct `scheduled_at` and `job_id = NULL` initially → `job_id` updated after BullMQ enqueue
- Enroll disabled sequence → `422 Unprocessable Entity` with `{ "error": "sequence_disabled" }`
- Two enrollments for same `(sequence_id, entity_id)` with distinct `dedup_key` → both active simultaneously
- Step fires → inside active hours window → `send_message` called with correct params and `dedup_key`
- Step fires → outside active hours window → `scheduled_at` updated to deferred time, `job_id` updated, no send; step fires correctly at deferred time
- All steps complete → enrollment status `completed`, `nurturing.enrollment_completed` published
- Unenroll mid-sequence → pending steps `cancelled`; optimistic lock causes in-flight step worker to exit cleanly
- Duplicate enroll with same `dedup_key` → idempotent, single enrollment row, `200 OK`
- `opt_out.received` → all active enrollments for entity unenrolled across all sequences
- A/B: variant assigned at enrollment, correct variant override params applied at step execution
- `call_ai` step with `auto_send: false` → `{ system_prompt, user_prompt, model }` sent to AI Service; output stored in `step_executions.output`, `nurturing.step_output_ready` published, retrievable via `GET .../output`
- `call_ai` step with `auto_send: true` → synthetic `send_message` called with AI output as body
- `emit_event` with `include_context: true` → enrollment context merged into payload, explicit payload fields take precedence
- Safety-net poller → step with `job_id IS NOT NULL` and overdue `scheduled_at` re-enqueued; executes correctly; no duplicate send (Messaging Service dedup_key guard)
- Startup scanner (async, non-blocking) → step with `job_id IS NULL` re-enqueued after startup; server accepts traffic before scan completes
- Step max retries (5 attempts) → step `failed`, enrollment `failed`, `nurturing.step_failed` published with correct payload shape
- Optimistic lock race: two workers pick up same step simultaneously → only first proceeds, second exits cleanly

### Contract Tests

**Outbound** — verify calls to platform services match expected API shape (all outbound calls):
- `POST /templates/render` — `template_id` + context, called before send actions
- `POST /messages/send` — pre-rendered `body` (not `template_id`), `dedup_key` present
- `POST /emails/send` — pre-rendered `subject` + `body_html` + `body_text` (not `template_id`), required fields
- `POST /ai/complete` — `{ system_prompt, user_prompt, model }` — two-field prompt structure, no `prompt_id`
- EventBridge `nurturing.*` events — payload shape against `@ortho/event-bus` schema

**Inbound** — verify `opt_out.received` SQS consumer correctly validates and handles malformed events without crashing.

---

## 11. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Scheduling mechanism | BullMQ delayed jobs | Handles any delay duration natively; no polling loop; matches Automation Engine infrastructure |
| Delay anchor | Enrollment time | Predictable, deterministic scheduling; active hours deferral on one step does not shift other steps |
| `job_id` on step rows | Yes | Enables startup scan to recover never-enqueued steps; enables safety-net poller to distinguish orphaned vs. legitimately delayed steps |
| Optimistic lock on status | `UPDATE ... WHERE status='pending' RETURNING id` | Prevents double execution when two workers race on the same step |
| Active hours deferral | Updates `scheduled_at` + `job_id` in step row | Keeps safety-net poller accurate; prevents false-positive re-enqueuing of legitimately deferred steps |
| Sequences are linear | No branch nodes | Branching belongs in Automation Engine; sequences are execution, not routing logic |
| Cancellation mechanism | Explicit unenroll + optimistic lock guard | Atomic DB update; race-condition handled by optimistic lock, not by duplicate check |
| Context snapshot at enrollment | Yes | Nurturing Engine never calls product services; platform/product isolation preserved |
| A/B variant assignment | At enrollment time, uniform across all steps | Consistent per-entity experience; simple conversion attribution |
| A/B statistical test | Two-proportion z-test | Standard for conversion rate comparison; p < 0.05 with minimum 100 enrollments per variant |
| `dedup_key` on enrollment | Caller-supplied, event_id-based | Caller (Automation Engine) uses `{{event_id}}` — unique per trigger event; re-entry naturally produces a new event_id; Automation Engine's own idempotency guard prevents duplicate enrollment calls |
| Multiple concurrent enrollments | Allowed with distinct `dedup_key` | Same entity in same sequence with different `dedup_key` values is valid |
| Disabled sequence enrollment | `422 Unprocessable Entity` | Clear rejection signal; `404` would mislead callers into thinking the sequence doesn't exist |
| No `dedup_key` on unenroll | Omitted | Unenrollment is inherently idempotent by `(sequence_id, entity_type, entity_id, status='active')` DB match; no separate key needed |
| `@ortho/interpolator` package | Created fresh in this iteration | Both field interpolator + active-hours calculator needed; not pre-existing |
| Safety-net poller placement | In-process Fastify plugin (not separate ECS task) | Eliminates extra ECS task definition; Redis distributed lock prevents multi-instance duplicate runs |
| Startup scanner blocking | Non-blocking (async background) | Server starts accepting traffic immediately; recovery happens in background |
| BullMQ retry count | 5 total attempts (1 initial + 4 retries) | Covers 4 backoff delays (5s → 30s → 2m → 10m) |
| `call_ai` params | `{ system_prompt, user_prompt, model }` | Two-field prompt structure matching AI Service API |
| `emit_event` DSL | `payload` object + optional `include_context` flag | Allows precise payload control while optionally forwarding full enrollment context |
| `stage_entered_at` source | Lead Service API (`GET /leads/:id`) | Stored on lead record; Conversation Service fetches via API at log time |
| `unenroll_sequence` amendment scope | Type definition only in this iteration | Full worker implementation deferred to Automation Engine iteration |
| Event type additions | `@ortho/types` TypeScript types only | Publishing implementations deferred to respective service iterations |
| Bootstrap sequence seed | SQL comment in migration file | Operators activate when ready; no automated seed to avoid unintended live sequences |
| Shared interpolator + active-hours | `@ortho/interpolator` package | Prevents logic divergence between Automation Engine and Nurturing Engine |
| `call_ai` output surfacing | `nurturing.step_output_ready` → Conversation Service → Notification Service WebSocket → coordinator browser polls output endpoint | Decouples Nurturing Engine from product UI; platform never calls product services directly |
| Opt-out SQS queue | Dedicated per service | Standard EventBridge fan-out; each subscriber gets independent copy; no queue sharing between services |
