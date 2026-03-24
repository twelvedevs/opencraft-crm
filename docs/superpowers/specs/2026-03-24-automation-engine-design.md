# Automation Engine — Design Spec

**Date:** 2026-03-24
**Status:** Approved
**Scope:** Platform-layer Automation Engine — event-driven rule execution, queue-backed action dispatch, `@platform/automation-ui` React component

---

## 1. Overview

The Automation Engine is a **platform-layer service** (`apps/platform/automation`) that subscribes to domain events from AWS EventBridge, evaluates configured automation rules, and dispatches action chains via BullMQ workers. It is fully generic — it has no knowledge of Ortho CRM concepts such as leads, pipeline stages, or coordinators.

**Core responsibilities:**
- Subscribe to EventBridge events via an SQS queue
- Match events against configured automation rules
- Evaluate boolean condition trees against event payloads in-memory
- Enqueue action chains as BullMQ jobs with per-action retry semantics
- Ship `@platform/automation-ui` React component for staff to build and monitor rules

**Out of scope:**
- Time-delayed sequences (delegated to Nurturing Engine via `enroll_sequence` action)
- Stage timeout scheduling (delegated to Pipeline Engine, which emits `lead.stage_timeout` events)
- Human-in-the-loop approval flows (coordinator approves AI drafts via product UI; approval fires a new event)

---

## 2. Architecture

```
AWS EventBridge events
        │
        ▼ (SQS subscription — durable buffer)
  ┌─────────────────────────────────────────────────┐
  │           Automation Engine                      │
  │   apps/platform/automation                       │
  │                                                  │
  │  Event Consumer → Rule Matcher                   │
  │                       │                          │
  │              Condition Evaluator (in-memory)     │
  │                       │                          │
  │              Execution Manager                   │
  │          (writes execution + steps to DB)        │
  │                       │                          │
  │              BullMQ Action Queue (Redis)         │
  │                       │                          │
  │  ┌──────────┬──────────┬───────────┬──────────┐  │
  │  send_msg  send_email call_ai  enroll_seq  ...  │  │
  └─────────────────────────────────────────────────┘
        │           │          │          │
  Messaging    Email Svc   AI Svc   Nurturing
  Service                           Engine
```

**SQS in front of EventBridge:** EventBridge delivers to SQS, the engine polls SQS. This decouples delivery from processing and prevents dropped events during deployments or restarts.

**BullMQ between Execution Manager and workers:** Each action in a chain is an independent job. A transient failure in one action retries only that action — not the entire chain. Other jobs in the chain wait for the failed job to complete (or fail permanently) before proceeding.

**Golden rule compliance:** The engine never calls product-layer APIs directly. Product-layer side effects (assign coordinator, create task, update pipeline field) are triggered via the `emit_event` action, which publishes `automation.action_requested` to EventBridge. Product services subscribe and react.

---

## 3. Rule DSL

Rules are stored as JSON in the `platform_automation` PostgreSQL schema. The engine is a generic interpreter of this DSL — product concepts are absent.

### 3.1 Rule Structure

```json
{
  "id": "uuid",
  "name": "Welcome SMS — New Lead",
  "version": 3,
  "enabled": true,

  "trigger": {
    "event_type": "lead.created"
  },

  "condition": {
    "op": "AND",
    "conditions": [
      {
        "field": "payload.source",
        "op": "in",
        "value": ["google", "facebook"]
      },
      {
        "field": "payload.opted_out",
        "op": "eq",
        "value": false
      }
    ]
  },

  "active_hours": {
    "start": "08:00",
    "end": "20:00",
    "timezone_field": "payload.location_timezone"
  },

  "action_tree": {
    "type": "send_message",
    "params": {
      "template_id": "welcome-sms-v2",
      "to_field": "payload.phone",
      "from_field": "payload.location_number",
      "context": "payload",
      "dedup_key": "{{event_id}}-sms-1"
    },
    "next": {
      "type": "branch",
      "condition": {
        "field": "payload.source",
        "op": "eq",
        "value": "google"
      },
      "if_true": {
        "type": "enroll_sequence",
        "params": {
          "sequence_id": "seq-google-new-lead",
          "entity_type": "payload.entity_type",
          "entity_id": "payload.entity_id",
          "context": "payload"
        }
      },
      "if_false": {
        "type": "enroll_sequence",
        "params": {
          "sequence_id": "seq-default-new-lead",
          "entity_type": "payload.entity_type",
          "entity_id": "payload.entity_id",
          "context": "payload"
        }
      }
    }
  }
}
```

### 3.2 Condition Operators

| Operator | Description |
|---|---|
| `eq` / `neq` | Equality / inequality |
| `in` / `not_in` | Value in array |
| `gt` / `gte` / `lt` / `lte` | Numeric comparison |
| `contains` | Array or string contains value |
| `exists` / `not_exists` | Field presence check |
| `AND` / `OR` / `NOT` | Boolean grouping (nestable) |

### 3.3 Field Interpolation

Any param value using dot-notation (e.g. `"payload.phone"`) is resolved against the event at execution time. Template strings like `"{{event_id}}-sms"` are resolved against execution context. The same resolver runs in both condition evaluation and action param binding — one consistent mechanism throughout.

### 3.4 Versioning

When a rule is updated, a new version row is written. The Execution Manager snapshots the current `action_tree` into the execution record at trigger time. In-flight steps execute against the snapshot — not the live rule. Marketing managers can safely edit rules without affecting running jobs.

---

## 4. Database Schema — `platform_automation`

```sql
-- Rule definitions
automation_rules (
  id                uuid PRIMARY KEY,
  name              text NOT NULL,
  version           integer NOT NULL DEFAULT 1,
  enabled           boolean NOT NULL DEFAULT false,
  trigger_event_type text NOT NULL,          -- indexed
  condition         jsonb,
  active_hours      jsonb,
  action_tree       jsonb NOT NULL,
  created_by        uuid,
  created_at        timestamptz,
  updated_at        timestamptz
)

-- One record per event+rule match
automation_executions (
  id                uuid PRIMARY KEY,
  rule_id           uuid REFERENCES automation_rules,
  rule_version      integer NOT NULL,
  action_tree_snapshot jsonb NOT NULL,       -- snapshot at trigger time
  event_id          text NOT NULL,           -- idempotency key
  event_type        text NOT NULL,
  entity_type       text,
  entity_id         text,
  status            text NOT NULL,           -- pending|running|completed|failed
  started_at        timestamptz,
  completed_at      timestamptz,
  UNIQUE (event_id, rule_id)                 -- idempotency constraint
)

-- One record per action node in the chain
automation_execution_steps (
  id                uuid PRIMARY KEY,
  execution_id      uuid REFERENCES automation_executions,
  action_type       text NOT NULL,
  action_params     jsonb,
  status            text NOT NULL,           -- pending|running|completed|failed|skipped
  attempt           integer NOT NULL DEFAULT 0,
  error             text,
  started_at        timestamptz,
  completed_at      timestamptz
)
```

---

## 5. Execution Flow

### 5.1 Happy Path

1. **SQS → Event Consumer:** Validate event schema. Extract `event_id`, `event_type`, `entity_type`, `entity_id`, `payload`. Check `automation_executions` for existing `(event_id, rule_id)` — skip if already completed (idempotency).

2. **Rule Matcher:** `SELECT` all enabled rules where `trigger_event_type = event_type`. Rules cached in-memory with 30s TTL — DB hit only on cache miss or after rule update invalidates cache.

3. **Condition Evaluator:** For each matched rule, evaluate condition tree in-memory against event payload. Pure function — no DB, no I/O. Only passing rules proceed.

4. **Execution Manager:** For each passing rule:
   - `INSERT automation_execution` (status: running), storing `rule_version` and `action_tree_snapshot`
   - Walk action_tree, `INSERT` one `execution_step` row per action node (status: pending)
   - Enqueue root action job to BullMQ with `execution_id + step_id`

5. **Action Worker:** Pick up job. Check active_hours window — if outside, `BullMQ.delay()` to next window open time. Otherwise: execute action (HTTP call to platform service). Update step status → completed. Enqueue next action job, or mark execution completed.

6. **Branch Resolution:** When `action_type == "branch"`: evaluate branch condition against original event payload. Enqueue the winning path's first action. Mark the other path's steps as `skipped`.

### 5.2 Fault Handling

| Scenario | Behaviour |
|---|---|
| Action fails (transient) | BullMQ retries with exponential backoff: 5s → 30s → 2m → 10m. Attempt count written to `execution_step.attempt`. |
| Action fails (max retries) | Job moves to BullMQ dead-letter queue. Step → `failed`. Execution → `failed`. Datadog alert fires. |
| Service crash mid-chain | BullMQ job was not ACKed → automatically re-queued on worker restart. Dedup key on platform service call prevents double-send. |
| Duplicate EventBridge delivery | Step 1 checks `(event_id, rule_id)` unique constraint. Already completed → discard. |
| Rule updated mid-execution | In-flight steps use `action_tree_snapshot` stored at execution start — not the live rule. |

### 5.3 Active Hours

Only `send_message` and `send_email` actions respect active hours. `emit_event`, `enroll_sequence`, `call_webhook`, and `call_ai` execute immediately regardless.

```
worker picks up action job
  → rule has active_hours?
      YES → resolve timezone from payload field
            → current time within window?
                YES → execute immediately
                NO  → BullMQ delay(ms until next window open)
      NO  → execute immediately
```

---

## 6. Action Types

### `send_message`
Sends SMS/MMS via Messaging Service (`POST /messages/send`). Template rendered by Messaging Service. Respects active_hours. `dedup_key` prevents double-send on retry.

```json
{
  "template_id": "welcome-sms",
  "to_field": "payload.phone",
  "from_field": "payload.location_number",
  "context": "payload",
  "dedup_key": "{{event_id}}-sms"
}
```

### `send_email`
Sends transactional email via Email Service (`POST /emails/send`). Respects active_hours.

```json
{
  "template_id": "post-exam-email",
  "to_field": "payload.email",
  "context": "payload",
  "dedup_key": "{{event_id}}-email"
}
```

### `call_ai`
Generates AI draft via AI Service (`POST /ai/complete`). Result stored in execution step output. When `auto_send: false` (default), draft is surfaced to staff via product UI — not sent automatically. When `auto_send: true` (requires explicit manager config), output feeds directly into a subsequent `send_message` action.

```json
{
  "prompt_id": "smart-reply-draft",
  "context": "payload",
  "model": "haiku",
  "store_as": "ai_draft",
  "auto_send": false
}
```

### `enroll_sequence`
Enrolls the entity in a Nurturing Engine drip sequence (`POST /sequences/enroll`). All time-delayed follow-up logic (24hr SMS, 3-day re-engagement, etc.) lives in the sequence — not in the Automation Engine. Executes immediately, ignores active_hours.

```json
{
  "sequence_id": "new-patient-contacted",
  "entity_type": "payload.entity_type",
  "entity_id": "payload.entity_id",
  "context": "payload"
}
```

### `emit_event`
Publishes a new event to EventBridge. Primary mechanism for triggering product-layer side effects (assign coordinator, create task, update field) without the engine importing product types. Product services subscribe to `automation.action_requested` and react to known action names. Executes immediately.

```json
{
  "event_type": "automation.action_requested",
  "payload": {
    "action": "assign_coordinator",
    "entity_type": "payload.entity_type",
    "entity_id": "payload.entity_id",
    "params": { "location_id": "payload.location_id" }
  }
}
```

### `call_webhook`
Calls an arbitrary external HTTP URL. Intended for EHR integration, third-party notifications, or custom product hooks. Secrets resolved from environment config at runtime — never stored raw in rule JSON.

```json
{
  "url": "https://ehr.internal/events",
  "method": "POST",
  "headers": { "Authorization": "{{webhook_secret}}" },
  "body": "payload",
  "timeout_ms": 5000
}
```

### `branch`
Control flow node — not an HTTP action. Evaluates a condition against the event payload and routes to `if_true` or `if_false`. The unselected path's steps are marked `skipped`. Branches can be nested.

```json
{
  "type": "branch",
  "condition": { "field": "payload.has_email", "op": "eq", "value": true },
  "if_true": { "type": "send_email", "params": { ... } },
  "if_false": { "type": "send_message", "params": { ... } }
}
```

---

## 7. `@platform/automation-ui` React Component

Exported from `packages/@platform/automation-ui`. Calls Automation Engine API directly from the browser (not proxied through CRM API Gateway). Auth via same Identity Service JWT token the CRM shell holds.

### Views

**Rule List:** Table of all rules with name, trigger event, action count, version, status (Draft / Active / Disabled), and edit link.

**Rule Builder:**
- Trigger event selector (dropdown of known event types)
- Condition builder — visual AND/OR tree with field/operator/value inputs per row; groups nestable
- Action chain builder — vertical tree of action nodes; branch nodes split into two columns (if_true / if_false); each node editable inline
- Active hours config (start/end time + timezone field picker)
- Save Draft / Activate Rule buttons

**Execution Log:** Table of recent executions showing time, rule name, entity ID, per-step status badges (✓ completed, ✗ failed, – skipped), and overall status. Each row expandable to show full step detail, params, response, retry attempts, and error messages.

### Rule States

| State | Description |
|---|---|
| Draft | Editable, not running. Safe to modify freely. |
| Active | Running live. Editing creates a new draft version; previous version stays active until new version is activated. |
| Disabled | Paused. No new executions. Existing in-flight executions complete. |

Only Marketing Managers can activate or disable rules. Marketing Staff can create and edit drafts.

---

## 8. Infrastructure & Service Layout

```
apps/platform/automation/
├── src/
│   ├── routes/           # Fastify REST API (rule CRUD, execution log query)
│   ├── services/
│   │   ├── rule-matcher.ts
│   │   ├── condition-evaluator.ts    # pure function
│   │   ├── field-interpolator.ts     # pure function
│   │   ├── active-hours.ts           # pure function
│   │   ├── execution-manager.ts
│   │   └── action-workers/
│   │       ├── send-message.worker.ts
│   │       ├── send-email.worker.ts
│   │       ├── call-ai.worker.ts
│   │       ├── enroll-sequence.worker.ts
│   │       ├── emit-event.worker.ts
│   │       ├── call-webhook.worker.ts
│   │       └── branch.worker.ts
│   ├── repositories/     # DB access (platform_automation schema only)
│   ├── events/           # EventBridge publisher (emit_event action)
│   └── index.ts
├── migrations/
├── test/
├── Dockerfile
├── package.json
└── tsconfig.json
```

**Runtime dependencies:**
- PostgreSQL (shared RDS cluster, `platform_automation` schema)
- Redis (BullMQ — ECS sidecar or ElastiCache)
- AWS SQS (EventBridge subscription)

---

## 9. Testing Strategy

### Unit Tests (Vitest)
Pure function coverage with no external dependencies:
- **Condition Evaluator:** All operators, nested AND/OR/NOT, missing fields, null values, type coercion
- **Action Tree Walker:** Correct job ordering, branch resolution, skipped step identification
- **Field Interpolator:** Dot-notation resolution, template string substitution, missing field handling
- **Active Hours Calculator:** Window boundary cases, DST edge cases, delay-until timestamp accuracy

### Integration Tests (Vitest + real Postgres + real Redis)
Platform service calls mocked via HTTP interceptor:
- Full rule execution — happy path
- Branch resolution (if_true and if_false paths)
- Retry on transient failure (assert attempt count, eventual success)
- Dead-letter on max retries (assert step + execution status = failed)
- Idempotency — duplicate event delivery (assert platform service called exactly once)
- Condition mismatch — no execution created

### Contract Tests
Verify outbound HTTP calls match what platform services expect:
- `POST /messages/send` — payload shape, required fields, dedup_key
- `POST /emails/send` — payload shape, context format
- `POST /ai/complete` — prompt_id, context, model routing
- `POST /sequences/enroll` — entity_type, entity_id, sequence_id, context
- EventBridge `automation.action_requested` — payload shape against `@ortho/event-bus` schema

**Test tooling:** `@ortho/testing` package provides DB fixtures, Redis fixtures, EventBridge mock, and HTTP factory stubs shared across all services.

---

## 10. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Workflow engine | None (BullMQ only) | Action chains are short (< 1s). Time delays → Nurturing Engine. Human approvals → new events. Temporal/Trigger.dev would be significant infra overhead for this workload. |
| Scheduler | None | Nurturing Engine owns time-delayed sequences. Pipeline Engine emits `stage_timeout` events. Automation Engine is purely event-reactive. |
| Product-layer actions | `emit_event` → EventBridge | Keeps platform service free of product types. Product services subscribe to `automation.action_requested`. |
| Event enrichment | Fat events (publisher includes all context) | Condition evaluator never needs to fetch additional data. Keeps evaluation pure and fast. |
| Condition complexity | Boolean expression tree (nested AND/OR/NOT + comparison ops) | Covers realistic marketing manager use cases without needing a full expression language. |
| Action chain shape | Branching tree (if/else, nestable) | Sufficient for all identified use cases. Full DAG (merge paths) not needed and would complicate UI significantly. |
| Fault tolerance | Per-action BullMQ retry + dedup keys | Per-action retry avoids re-sending already-completed actions on chain retry. Dedup keys handle at-least-once delivery safely. |
