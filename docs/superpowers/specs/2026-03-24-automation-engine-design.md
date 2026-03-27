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

Rules are stored as versioned JSON in the `platform_automation` PostgreSQL schema. The engine is a generic interpreter of this DSL — product concepts are absent.

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
          "context": "payload",
          "dedup_key": "{{event_id}}-enroll-google"
        }
      },
      "if_false": {
        "type": "enroll_sequence",
        "params": {
          "sequence_id": "seq-default-new-lead",
          "entity_type": "payload.entity_type",
          "entity_id": "payload.entity_id",
          "context": "payload",
          "dedup_key": "{{event_id}}-enroll-default"
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

The field interpolator resolves references at execution time using the event as context. Two resolution forms:

- **Dot-notation path** (`"payload.phone"`) — resolved against the event object using lodash-style deep path lookup. Applies to any string value in `params`, including values nested inside objects (the interpolator recurses into all objects and arrays within `params`). For example, `"entity_type": "payload.entity_type"` inside a nested `payload` object is resolved to the actual entity type string, not left as a literal.
- **Template string** (`"{{event_id}}-sms"`) — resolved against execution context (`event_id`, `execution_id`, `rule_id`, `rule_version`).

A value that does not match either form is used as a literal string. The same resolver runs in both condition evaluation and action param binding — one consistent mechanism throughout.

### 3.4 Versioning

The `automation_rules` table is a rule group (name + status + pointer to active version). All versioned definitions live in `automation_rule_versions`. When a rule is edited, a new version row is inserted. The rule group's `active_version` pointer only advances when a manager explicitly activates the new version.

This allows an Active rule and its Draft revision to coexist simultaneously — the Rule Matcher always loads the `active_version`; the UI can display and edit the `current_version` (draft) without affecting live execution.

The Execution Manager snapshots the full `action_tree` from the active version into `automation_executions.action_tree_snapshot` at trigger time. In-flight steps always execute against this snapshot — not the live rule. Marketing managers can safely edit and activate rules without affecting running jobs.

**active_hours note:** `active_hours.start` and `active_hours.end` are time-of-day values only (`HH:MM`, 24-hour). There is no day-of-week constraint. The window applies every day. The Active Hours Calculator computes the delay-until timestamp as the next occurrence of `start` time in the resolved timezone, which is always within the next 24 hours.

### 3.5 Known Trigger Events

The Automation Engine is generic — any event type published to EventBridge can trigger a rule. The following events are the expected triggers from the Ortho CRM product layer:

| Event Type | Publisher | Notes |
|---|---|---|
| `lead.created` | Lead Service | `entity_type: "lead"` |
| `lead.stage_changed` | Pipeline Engine | `entity_type: "lead"`; payload includes `stage_to`, `reason` (valid values: `manual`, `timeout`, `no_show`, `converted`, `import`, `import_undo`), `time_in_stage_seconds`, `response_time_seconds?` |
| `lead.converted` | Pipeline Engine | `entity_type: "lead"` |
| `lead.stage_timeout` | Pipeline Engine | `entity_type: "lead"` |
| `lead.archived` | Pipeline Engine | `entity_type: "lead"` |
| `appointment.updated` | Lead Service | `entity_type: "lead"` |
| `referrer.created` | Referral Service | `entity_type: "referrer"`; payload includes `referrer_id`, `referrer_type` (`patient`\|`doctor`), `location_id`, `referral_link_id`, `referral_link_url`. Use `enroll_sequence` with `entity_type: "referrer"` + `entity_id: "payload.referrer_id"` to enroll patient referrers in post-treatment sequences. |
| `message.received` | Conversation Service | `entity_type: "lead"` |

---

## 4. Database Schema — `platform_automation`

```sql
-- Rule group: name, status, and pointer to active version
automation_rules (
  id                  uuid PRIMARY KEY,
  name                text NOT NULL,
  status              text NOT NULL DEFAULT 'draft',  -- draft|active|disabled
  active_version      integer,                         -- NULL until first activation
  current_version     integer NOT NULL DEFAULT 1,      -- latest draft version
  created_by          uuid,
  created_at          timestamptz,
  updated_at          timestamptz
)

-- One row per version of a rule definition
automation_rule_versions (
  id                  uuid PRIMARY KEY,
  rule_id             uuid REFERENCES automation_rules NOT NULL,
  version             integer NOT NULL,
  trigger_event_type  text NOT NULL,                   -- indexed
  condition           jsonb,
  active_hours        jsonb,
  action_tree         jsonb NOT NULL,
  created_by          uuid,
  created_at          timestamptz,
  UNIQUE (rule_id, version)
)

-- One record per event+rule match
automation_executions (
  id                    uuid PRIMARY KEY,
  rule_id               uuid REFERENCES automation_rules NOT NULL,
  rule_version          integer NOT NULL,
  action_tree_snapshot  jsonb NOT NULL,         -- snapshot of action_tree at trigger time
  event_id              text NOT NULL,          -- idempotency key
  event_type            text NOT NULL,
  entity_type           text,
  entity_id             text,
  status                text NOT NULL,          -- pending|running|completed|failed
  started_at            timestamptz,
  completed_at          timestamptz,
  UNIQUE (event_id, rule_id)                    -- idempotency constraint
)

-- One record per action node in the chain (both branches pre-inserted at execution start)
automation_execution_steps (
  id                uuid PRIMARY KEY,
  execution_id      uuid REFERENCES automation_executions NOT NULL,
  action_type       text NOT NULL,
  action_params     jsonb,
  output            jsonb,                      -- result stored here (e.g. AI draft text)
  status            text NOT NULL,              -- pending|running|completed|failed|skipped
  attempt           integer NOT NULL DEFAULT 0,
  error             text,
  started_at        timestamptz,
  completed_at      timestamptz
)
```

---

## 5. Execution Flow

### 5.1 Happy Path

1. **SQS → Event Consumer:** Validate event schema against `@ortho/event-bus` inbound schema. Extract `event_id`, `event_type`, `entity_type`, `entity_id`, `payload`. Forward to Rule Matcher.

2. **Rule Matcher:** `SELECT` all `automation_rules` with `status = 'active'`, joined to their `active_version` row in `automation_rule_versions` where `trigger_event_type = event_type`. Rules cached in-memory with 30s TTL — DB hit only on cache miss. Cache invalidation is TTL-based only; no active cache-bust mechanism. A rule activation or disable takes effect within 30 seconds across all running instances.

3. **Condition Evaluator:** For each matched rule, evaluate condition tree in-memory against event payload. Pure function — no DB, no I/O. Only passing rules proceed.

4. **Execution Manager:** For each passing rule:
   - Check `automation_executions` for existing `(event_id, rule_id)` — skip if already completed (idempotency). This check is per-rule, after matching, not before.
   - `INSERT automation_execution` (status: running), storing `rule_version` and `action_tree_snapshot`
   - Walk the full `action_tree` recursively — including both `if_true` and `if_false` branches of every `branch` node at every nesting level — and `INSERT` one `execution_step` row per action node (status: pending). All steps are pre-inserted before any job is enqueued.
   - Enqueue root action job to BullMQ with `execution_id + step_id`

5. **Action Worker:** Pick up job. Execute action (HTTP call to platform service) following action-specific rules (see Section 5.3). Update step status → completed. Store output in `execution_step.output` if applicable. Enqueue next action job, or mark execution completed.

6. **Branch Resolution:** When `action_type == "branch"`: evaluate branch condition against original event payload. Enqueue the winning path's first action. Mark all steps in the losing path as `skipped`.

### 5.2 Fault Handling

| Scenario | Behaviour |
|---|---|
| Action fails (transient) | BullMQ retries with exponential backoff: 5s → 30s → 2m → 10m. Attempt count written to `execution_step.attempt`. |
| Action fails (max retries) | Job moves to BullMQ dead-letter queue. Step → `failed`. Execution → `failed`. Datadog alert fires. |
| Service crash mid-chain | BullMQ job was not ACKed → automatically re-queued on worker restart. `dedup_key` on outbound call prevents double-execution. |
| Duplicate EventBridge delivery | Step 4 checks `(event_id, rule_id)` unique constraint per matched rule. Already completed → skip that rule. |
| Rule updated mid-execution | In-flight steps use `action_tree_snapshot` stored at execution start — not the live rule. |

### 5.3 Active Hours

Active hours are checked **only inside `send_message` and `send_email` workers**. All other action types (`emit_event`, `enroll_sequence`, `call_webhook`, `call_ai`) execute immediately regardless of whether the rule defines `active_hours`. The rule-level `active_hours` config is ignored by non-messaging workers.

```
send_message or send_email worker picks up job
  → rule_snapshot has active_hours?
      YES → resolve timezone: interpolate timezone_field from event payload
            → current time in that timezone within [start, end] window?
                YES → execute immediately
                NO  → compute ms until next window open (≤ 24h away)
                      BullMQ delay(ms) — job re-queued, picked up at open time
      NO  → execute immediately
```

---

## 6. Action Types

All action types support an optional `dedup_key` param. `send_message` and `send_email` require it. For `enroll_sequence`, `call_ai`, and `call_webhook`, including a `dedup_key` is strongly recommended — the receiving service uses it to reject duplicate calls caused by BullMQ retries after a worker crash.

### `send_message`
Sends SMS/MMS via Messaging Service (`POST /messages/send`). Respects `active_hours`.

**Worker call chain:** The `send_message` worker calls `POST /templates/render` on the Template Service first (with `template_id` + resolved `context`), receives the rendered `body_text`, then calls `POST /messages/send` on the Messaging Service with the pre-rendered `body`. The `template_id` param in the action config is consumed exclusively by the worker — it is never forwarded to the Messaging Service.

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
Sends transactional email via Email Service (`POST /emails/send`). Respects `active_hours`.

**Worker call chain:** The `send_email` worker calls `POST /templates/render` on the Template Service first (with `template_id` + resolved `context`), receives the rendered `subject` + `body_html` + `body_text`, then calls `POST /emails/send` on the Email Service with the pre-rendered content. The `template_id` param in the action config is consumed exclusively by the worker — it is never forwarded to the Email Service.

```json
{
  "template_id": "post-exam-email",
  "to_field": "payload.email",
  "context": "payload",
  "dedup_key": "{{event_id}}-email"
}
```

### `call_ai`
Generates AI draft via AI Service (`POST /ai/complete`). The response is stored in `execution_step.output` as `{ "ai_draft": "<text>" }`.

- When `auto_send: false` (default): execution step completes with draft stored in `output`. The Automation Engine exposes `GET /executions/:id/steps/:stepId/output` — the product UI polls this endpoint to surface the draft to the coordinator for review.
- When `auto_send: true` (requires explicit manager config): the worker chains immediately into a `send_message` call using the AI output as the message body — no human review. The `dedup_key` for the synthetic `send_message` call is derived deterministically as `{{event_id}}-ai-autosend`. Rules using `auto_send: true` should not also declare a subsequent `send_message` node — the worker constructs the send internally.

Does not respect `active_hours` — AI generation executes immediately; if chaining to `send_message`, that step respects `active_hours`.

```json
{
  "prompt_id": "smart-reply-draft",
  "context": "payload",
  "model": "haiku",
  "store_as": "ai_draft",
  "auto_send": false,
  "dedup_key": "{{event_id}}-ai"
}
```

### `enroll_sequence`
Enrolls the entity in a Nurturing Engine drip sequence (`POST /sequences/enroll`). All time-delayed follow-up logic (24hr SMS, 3-day re-engagement, etc.) lives in the sequence — not in the Automation Engine. Executes immediately, ignores `active_hours`.

```json
{
  "sequence_id": "new-patient-contacted",
  "entity_type": "payload.entity_type",
  "entity_id": "payload.entity_id",
  "context": "payload",
  "dedup_key": "{{event_id}}-enroll"
}
```

### `emit_event`
Publishes a new event to EventBridge. Primary mechanism for triggering product-layer side effects (assign coordinator, create task, update field) without the engine importing product types. Product services subscribe to `automation.action_requested` and react to known action names. Executes immediately.

The `payload` object is a static template — all string values within it are resolved by the field interpolator recursively before publishing. In the example below, `"payload.entity_type"` and `"payload.entity_id"` are dot-notation paths that resolve to actual values at runtime.

Include `dedup_key` in the published payload. EventBridge delivery is at-least-once; product service consumers must use the `dedup_key` to guard against processing duplicate `automation.action_requested` events (e.g., double-assigning a coordinator).

```json
{
  "event_type": "automation.action_requested",
  "payload": {
    "action": "assign_coordinator",
    "entity_type": "payload.entity_type",
    "entity_id": "payload.entity_id",
    "params": { "location_id": "payload.location_id" },
    "dedup_key": "{{event_id}}-emit-assign"
  }
}
```

### `call_webhook`
Calls an arbitrary external HTTP URL. Intended for EHR integration, third-party notifications, or custom product hooks. Secret values in `headers` (e.g. `"{{webhook_secret}}"`) are resolved from **AWS Secrets Manager** at runtime by the worker — the secret name is the template key (e.g. `webhook_secret`). Secret values are never stored in rule JSON.

```json
{
  "url": "https://ehr.internal/events",
  "method": "POST",
  "headers": { "Authorization": "{{webhook_secret}}" },
  "body": "payload",
  "timeout_ms": 5000,
  "dedup_key": "{{event_id}}-webhook"
}
```

### `branch`
Control flow node — not an HTTP action. Evaluates a condition against the event payload and routes to `if_true` or `if_false`. The unselected path's steps are marked `skipped`. Branches can be nested — both sides of every nested branch are pre-inserted as `pending` steps at execution start, ensuring full execution history regardless of nesting depth.

```json
{
  "type": "branch",
  "condition": { "field": "payload.has_email", "op": "eq", "value": true },
  "if_true": { "type": "send_email", "params": { "..." : "..." } },
  "if_false": { "type": "send_message", "params": { "..." : "..." } }
}
```

---

## 7. `@platform/automation-ui` React Component

Exported from `packages/@platform/automation-ui`. Calls Automation Engine API directly from the browser (not proxied through CRM API Gateway). Auth via same Identity Service JWT token the CRM shell holds.

### Views

**Rule List:** Table of all rules with name, trigger event, action count, current version, status (Draft / Active / Disabled), and edit link.

**Rule Builder:**
- Trigger event selector (dropdown of known event types)
- Condition builder — visual AND/OR tree with field/operator/value inputs per row; groups nestable
- Action chain builder — vertical tree of action nodes; branch nodes split into two columns (if_true / if_false); each node editable inline
- Active hours config (start/end time + timezone field picker)
- Save Draft / Activate Rule buttons

**Execution Log:** Table of recent executions showing time, rule name, entity ID, per-step status badges (✓ completed, ✗ failed, – skipped), and overall status. Each row expandable to show full step detail, params, output (including AI draft text), retry attempts, and error messages.

### Rule States

| State | Description |
|---|---|
| Draft | Editable, not running. `active_version` is NULL or points to a previous version. |
| Active | Running live. `active_version` points to the current active version. Editing inserts a new `automation_rule_versions` row and increments `current_version`; `active_version` stays unchanged until the manager activates the new version. |
| Disabled | Paused. No new executions triggered. In-flight executions complete normally. |

Two versions of the same rule (an Active version and a Draft revision) coexist via separate rows in `automation_rule_versions`. The Rule Matcher always loads `active_version`; the UI displays and edits `current_version`.

Only Marketing Managers can activate or disable rules. Marketing Staff can create and edit drafts.

---

## 8. Infrastructure & Service Layout

```
apps/platform/automation/
├── src/
│   ├── routes/           # Fastify REST API (rule CRUD, execution log query, step output)
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
- AWS Secrets Manager (secret resolution for `call_webhook` headers)

---

## 9. Testing Strategy

### Unit Tests (Vitest)
Pure function coverage with no external dependencies:
- **Condition Evaluator:** All operators, nested AND/OR/NOT, missing fields, null values, type coercion
- **Action Tree Walker:** Correct job ordering, branch resolution, skipped step identification, full recursion of nested branches
- **Field Interpolator:** Dot-notation resolution (including nested objects), template string substitution, missing field handling
- **Active Hours Calculator:** Window boundary cases, DST edge cases, delay-until timestamp accuracy (always ≤ 24h), time-of-day-only constraint (no day-of-week)

### Integration Tests (Vitest + real Postgres + real Redis)
Platform service calls mocked via HTTP interceptor:
- Full rule execution — happy path
- Branch resolution (if_true and if_false paths)
- Nested branch — assert all pre-inserted steps present, correct path executed, both losing-path levels skipped
- Retry on transient failure (assert attempt count, eventual success)
- Dead-letter on max retries (assert step + execution status = failed)
- Idempotency — duplicate event delivery (assert platform service called exactly once)
- Condition mismatch — no execution created
- `call_ai` with `auto_send: false` — assert output stored in `execution_step.output`, step completed, `GET /executions/:id/steps/:stepId/output` returns the AI draft
- `call_ai` with `auto_send: true` — assert synthetic `send_message` called with correct body and deterministic `dedup_key`
- Active hours delay — send_message outside window defers; emit_event in same chain executes immediately

### Contract Tests
**Outbound** — verify calls to platform services match their expected API shape:
- `POST /templates/render` — template_id + context shape; called by `send_message` and `send_email` workers before calling downstream Messaging/Email Service
- `POST /messages/send` — payload shape (pre-rendered `body`, not `template_id`), required fields, dedup_key
- `POST /emails/send` — payload shape (pre-rendered `subject` + `html` + `text`), context format
- `POST /ai/complete` — prompt_id, context, model routing (haiku vs sonnet)
- `POST /sequences/enroll` — entity_type, entity_id, sequence_id, context
- EventBridge `automation.action_requested` — payload shape against `@ortho/event-bus` schema

**Inbound** — verify the engine correctly validates incoming EventBridge events:
- Known event types (`lead.created`, `lead.stage_changed`, etc.) pass schema validation
- Malformed or unknown event types are rejected and logged without crashing the consumer

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
| Fault tolerance | Per-action BullMQ retry + dedup keys on all action types | Per-action retry avoids re-sending already-completed actions on chain retry. Dedup keys on all outbound calls handle at-least-once delivery safely. |
| Rule versioning | `automation_rules` (group) + `automation_rule_versions` (history) | Active and draft versions coexist. Rule Matcher loads `active_version`; UI edits `current_version`. Full history preserved for audit. |
| AI draft retrieval | Stored in `execution_step.output`, exposed via `GET /executions/:id/steps/:stepId/output` | Product UI polls this endpoint to surface drafts to coordinators. No coupling between Automation Engine and product-layer state. |
| Secret storage | AWS Secrets Manager | `call_webhook` header secrets resolved at runtime by key name. Never stored in rule JSON. |
