# Campaign Service — Updated Design Spec

**Date:** 2026-03-25
**Updated:** 2026-04-08
**Status:** Approved
**Scope:** Product-layer Campaign Service — email broadcast campaign lifecycle, comment-based approval workflow, BullMQ send orchestration, A/B holdout testing, 7-day conversion attribution.

> **About this document:** This is the authoritative version of the Campaign Service design, updated with all decisions recorded in `tasks/prd-questions-campaign-service.md`. Each clarification is tagged with its question number (Q1–Q13) where it first applies.

---

## 1. Overview

The Campaign Service is a **product-layer service** (`apps/crm/campaign`, schema `crm_campaigns`) that owns the full email broadcast campaign lifecycle: authoring, approval, scheduling, send orchestration, A/B winner selection, and conversion attribution.

**Core responsibilities:**
- Campaign CRUD with comment-based approval workflow (`draft → pending_review → approved → scheduled → sending → completed`)
- Audience resolution: calls Audience Engine for segment evaluation, Lead Service for recipient data
- Send orchestration: groups recipients by `location_id`, calls `POST /emails/campaigns/send` once per location
- A/B testing: holdout model (configurable test split %) with auto winner selection after a configurable delay, plus full-split mode (no holdout)
- Conversion attribution: subscribes to `lead.stage_changed` events via `@ortho/event-bus`, records conversions within a 7-day window anchored to the event occurrence timestamp
- Publishes `campaign.sent` event per `(campaign_id, location_id)` via `@ortho/event-bus` when Email Service reports send completion

**Out of scope:**
- Bulk SMS campaigns (owned by Conversation Service)
- Send time optimization (out of scope for v1)
- Template storage and rendering (owned by Template Service; Email Service renders per-recipient during bulk send)

---

## 2. Architecture

```
CRM API Gateway
      │ REST
      ▼
┌──────────────────────────────────────────────────────────┐
│                   Campaign Service                        │
│   apps/crm/campaign        schema: crm_campaigns         │
│                                                           │
│  Process A: REST API (Fastify)                            │
│  ├── Campaign CRUD + review comments                      │
│  ├── Approval workflow (submit / approve / reject)        │
│  └── Schedule / send-now / cancel                         │
│                                                           │
│  Process B: Workers + Consumer                            │
│  ├── BullMQ: campaign-orchestrate  → audience → send      │
│  ├── BullMQ: ab-winner-select      → pick winner          │
│  └── @ortho/event-bus consumer                            │
│      ├── email.campaign_completed → update campaign state │
│      ├── email.opened             → A/B open counter      │
│      └── lead.stage_changed       → conversion attribution│
└──────────────────────────────────────────────────────────┘
          │               │                │
   Audience Engine    Lead Service    Email Service
   (snapshot eval)   (email+context)  (bulk send jobs)
```

**Platform services consumed:**
- **Audience Engine** — `POST /audiences/segments/:id/evaluate`, `POST /audiences/evaluate` (inline)
- **Lead Service** — `GET /leads` (fetch candidate leads with pre-filters), `GET /leads?ids=...` (batch contact data fetch)
- **Email Service** — `POST /emails/campaigns/send` (one call per location per send phase), `POST /emails/spam-check`, `POST /emails/send` (test-send only)
- **Template Service** — `POST /templates/render` (test-send and on-demand spam check only; Email Service renders per-recipient for bulk sends)

**EventBridge subscriptions — `@ortho/event-bus` (Q1):**

All three inbound events are consumed via `bus.subscribe(eventType, handler)` + `bus.start()` from the `@ortho/event-bus` package. The dedicated SQS queue URL is provided via `SQS_QUEUE_URL`. The `src/handlers/sqs-consumer.ts` file contains only startup wiring — it creates the bus instance, registers the three handlers, and calls `bus.start()`.

- `email.campaign_completed` — Email Service signals a bulk send job finished
- `email.opened` — track per-variant opens for A/B winner selection
- `lead.stage_changed` — 7-day conversion attribution

**EventBridge publishing — `@ortho/event-bus` (Q2):**

`campaign.sent` is published via the same `bus` instance using `bus.publish()`. One event per `(campaign_id, location_id)` when Email Service reports job completion; carries `campaign_id`, `location_id`, `sent_count`. Subscribed by Analytics Service (`CampaignSentHandler` → increments `metrics_campaigns_daily.sent` by `sent_count`).

**Multi-location handling:** A campaign's segment may match leads across multiple locations. Since Email Service requires one `location_id` per send job, the orchestrate worker groups recipients by `location_id` and calls `POST /emails/campaigns/send` once per location. Each location send is tracked as a separate `campaign_sends` row.

**Email Service spec amendment required:** `POST /emails/campaigns/send` needs `entity_type` + `entity_id` fields (same as the transactional `POST /emails/send` already has) so that `email.opened` / `email.clicked` EventBridge events carry `entity_type: "campaign"` + `entity_id: "{campaign_id}"`. This enables Analytics Service to populate `metrics_campaigns_daily.opened` / `.clicked` and enables the Campaign Service `email.opened` handler to identify the owning campaign via `entity_id` without a separate reverse-lookup.

---

## 3. State Machine & Approval Workflow

### 3.1 Campaign Statuses

```
draft ──[submit]──► pending_review ──[approve]──► approved ──[schedule]──► scheduled
  ▲                       │                           │                         │
  │                       │                           │ [send-now]     [BullMQ fires]
  └──────[reject]─────────┘                           ▼                         │
                                                   sending ◄────────────────────┘
                                                      │
                                    ┌─────────────────┼──────────────────┐
                                    ▼                 ▼                  ▼
                                completed   completed_with_errors      failed

Any pre-sending state → cancelled  (Marketing Manager only, including pending_review)
scheduled → approved  via [unschedule]  (cancels BullMQ job, sets orchestrate_job_id = NULL)
```

Cancellation is available from `draft`, `pending_review`, `approved`, and `scheduled` states. A manager may cancel a campaign that is under review without first rejecting it. Cancellation is blocked once `status = 'sending'`.

### 3.2 A/B Sub-phases

Tracked in `campaigns.ab_phase` (only relevant while `status = 'sending'` and `ab_enabled = true`):

| `ab_phase` | Meaning |
|---|---|
| `null` | Non-A/B campaign, or A/B full_split (all sent at once, no holdout) |
| `testing` | Test groups A and B sent; `ab-winner-select` job is pending |
| `complete` | Winner selected; holdout send submitted (holdout mode) or all sends done (full_split) |

The `email.campaign_completed` completion check (Section 7.1) proceeds when `ab_phase = NULL` (non-A/B) or `ab_phase = 'complete'` (A/B holdout post-winner or full_split). It exits early only when `ab_phase = 'testing'` (holdout not yet resolved).

**Holdout mode flow:**
1. Orchestrate worker sends test groups A and B → sets `ab_phase = 'testing'` → enqueues `ab-winner-select` job with `winner_delay_hours` delay
2. `ab-winner-select` fires → computes open rates → sets `ab_winner` + `ab_phase = 'complete'` → submits holdout recipients with winning subject
3. `email.campaign_completed` arrives for holdout → campaign reaches terminal status

**Full-split mode flow:**
1. Orchestrate worker sends all recipients split 50/50 between A and B (two Email Service jobs per location), sets `ab_phase = 'complete'` immediately (no holdout)
2. Winner determined retrospectively from open counts when both jobs complete — for reporting only

### 3.3 Permission Matrix & Authorization Strategy (Q4)

| Action | Marketing Staff | Marketing Manager |
|---|---|---|
| Create / edit draft | ✓ | ✓ |
| Submit for review | ✓ | ✓ |
| Add comments | ✓ | ✓ |
| Approve / reject | — | ✓ |
| Schedule / send-now / cancel | — | ✓ |
| Re-schedule (`scheduled_for` only) | — | ✓ (no re-approval needed) |

**Authorization strategy (A + B):**

All campaign routes are gated by `requirePermission('campaigns:write')` from `@ortho/auth-middleware`.

Manager-only routes (approve, reject, schedule, unschedule, send-now, cancel) use an additional `requirePermission('campaigns:manage')` guard. This requires an amendment to `@ortho/auth-middleware`:
- Add `campaigns:manage` to `ROLE_PERMISSIONS` for `marketing_manager` and `super_admin` only.
- `marketing_staff` does NOT receive `campaigns:manage`.

Route-level guard pattern for manager-only endpoints:
```typescript
fastify.post(
  '/campaigns/:id/approve',
  {
    preHandler: [
      requirePermission('campaigns:write'),
      requirePermission('campaigns:manage'),
    ],
  },
  approveHandler,
)
```

This amendment to `@ortho/auth-middleware` is in scope for the Campaign Service PRD (see Section 12 — Pending Amendments).

**Content edit rule:** Fields that affect recipients or email content (`template_id`, `subject`, `segment_id`, `audience_filter`, A/B config) are locked once the campaign reaches `approved`. To change them, a manager must reject back to `draft`. `scheduled_for` is patchable by manager in `approved` or `scheduled` states without re-approval.

---

## 4. Database Schema — `crm_campaigns`

```sql
-- Main campaign record
campaigns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  status                text NOT NULL DEFAULT 'draft',
    -- draft|pending_review|approved|scheduled|sending|
    -- completed|completed_with_errors|failed|cancelled
  template_id           text NOT NULL,
  subject               text,           -- non-A/B subject; NULL when ab_enabled = true
  segment_id            uuid,           -- Audience Engine named segment (nullable)
  audience_filter       jsonb,          -- inline filter (nullable)
    -- exactly one of segment_id / audience_filter must be set (CHECK constraint)
  audience_snapshot_id  uuid,           -- populated by orchestrate worker at send time
  scheduled_for         timestamptz,
  orchestrate_job_id    text,           -- BullMQ job ID; NULL after unschedule/cancel

  -- A/B config (all NULL when ab_enabled = false)
  ab_enabled            boolean NOT NULL DEFAULT false,
  ab_mode               text,           -- 'holdout' | 'full_split'
  ab_test_split_pct     integer,        -- 1–49; holdout mode only
                                        -- e.g. 10 → 10% A, 10% B, 80% holdout
  ab_winner_delay_hours integer NOT NULL DEFAULT 4,
  ab_variant_a_subject  text,
  ab_variant_b_subject  text,
  ab_phase              text,           -- NULL | 'testing' | 'complete'
  ab_winner             text,           -- 'A' | 'B' | NULL
  ab_decision_at        timestamptz,    -- when ab-winner-select job fires
  ab_opens_a            integer NOT NULL DEFAULT 0,  -- atomic counter (UPDATE ... + 1)
  ab_opens_b            integer NOT NULL DEFAULT 0,  -- atomic counter (UPDATE ... + 1)
  ab_winner_job_id      text,           -- BullMQ job ID for ab-winner-select

  -- Approval
  created_by            uuid NOT NULL,
  approved_by           uuid,
  approved_at           timestamptz,

  sent_at               timestamptz,    -- when first Email Service call is made
  completed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT campaign_subject_check CHECK (
    (ab_enabled = false AND subject IS NOT NULL
      AND ab_variant_a_subject IS NULL AND ab_variant_b_subject IS NULL)
    OR
    (ab_enabled = true AND subject IS NULL
      AND ab_variant_a_subject IS NOT NULL AND ab_variant_b_subject IS NOT NULL)
  ),
  CONSTRAINT campaign_audience_check CHECK (
    (segment_id IS NOT NULL AND audience_filter IS NULL) OR
    (segment_id IS NULL    AND audience_filter IS NOT NULL)
  )
)

-- One row per Email Service job (one per location × send phase/variant)
campaign_sends (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      uuid REFERENCES campaigns NOT NULL,
  location_id      text NOT NULL,
  variant          text,              -- 'A' | 'B' | 'holdout' | NULL (non-A/B)
  subject_used     text NOT NULL,    -- actual subject sent; winning subject for holdout rows
  email_job_id     uuid,             -- Email Service job UUID (from 202 response)
  email_job_ref    text NOT NULL UNIQUE,
    -- "{campaign_id}:{location_id}"          for non-A/B
    -- "{campaign_id}:{location_id}:A"        for A/B variant A
    -- "{campaign_id}:{location_id}:B"        for A/B variant B
    -- "{campaign_id}:{location_id}:holdout"  for A/B holdout
  status           text NOT NULL DEFAULT 'pending',
    -- pending|processing|completed|completed_with_errors|failed|cancelled
  total_recipients integer NOT NULL DEFAULT 0,
  sent_count       integer NOT NULL DEFAULT 0,
  failed_count     integer NOT NULL DEFAULT 0,
  started_at       timestamptz,
  completed_at     timestamptz
)

-- Lead → campaign mapping for 7-day conversion attribution.
-- Holdout leads are inserted at orchestration time with sent_at = NULL (not yet sent).
-- sent_at is set when holdout send is submitted by ab-winner-select worker.
-- Conversion tracking only considers rows WHERE sent_at IS NOT NULL.
-- Bulk inserts are chunked at 1,000 rows per INSERT to avoid table lock contention.
campaign_recipients (
  campaign_id  uuid REFERENCES campaigns NOT NULL,
  lead_id      text NOT NULL,
  email        text NOT NULL,    -- snapshot at send time
  location_id  text NOT NULL,
  variant      text,             -- 'A' | 'B' | 'holdout' | NULL
  sent_at      timestamptz,      -- NULL for holdout until winner fires
  PRIMARY KEY (campaign_id, lead_id)
)

-- First qualifying stage change within 7 days of campaign send
campaign_conversions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid REFERENCES campaigns NOT NULL,
  lead_id       text NOT NULL,
  stage_to      text NOT NULL,
  pipeline      text NOT NULL,
  converted_at  timestamptz NOT NULL,  -- from event payload (occurred_at), not insert time
  UNIQUE (campaign_id, lead_id)  -- only first conversion per lead per campaign
)

-- State transition audit log
campaign_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid REFERENCES campaigns NOT NULL,
  from_status  text,             -- NULL on creation
  to_status    text NOT NULL,
  actor_id     uuid,             -- NULL for system transitions (BullMQ workers)
  comment      text,             -- required on reject; optional elsewhere
  created_at   timestamptz NOT NULL DEFAULT now()
)

-- Review discussion thread
campaign_comments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid REFERENCES campaigns NOT NULL,
  author_id    uuid NOT NULL,
  body         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
)
```

**Indexes:**

```sql
CREATE INDEX ON campaigns (status);
CREATE INDEX ON campaigns (scheduled_for, status) WHERE status = 'scheduled';
CREATE INDEX ON campaigns (ab_phase) WHERE ab_phase = 'testing';
CREATE INDEX ON campaign_sends (campaign_id, status);
CREATE INDEX ON campaign_sends (campaign_id, variant);
CREATE INDEX ON campaign_sends (email_job_id);
CREATE INDEX ON campaign_recipients (lead_id, sent_at);  -- conversion attribution hot path
CREATE INDEX ON campaign_recipients (campaign_id);
CREATE INDEX ON campaign_recipients (campaign_id, variant);  -- holdout fetch in ab-winner-select
CREATE INDEX ON campaign_conversions (campaign_id);
CREATE INDEX ON campaign_events (campaign_id);
CREATE INDEX ON campaign_comments (campaign_id);
```

**Notes:**
- `ab_opens_a` / `ab_opens_b` updated atomically: `UPDATE campaigns SET ab_opens_a = ab_opens_a + 1 WHERE id = ?`. Open rate denominator computed from `campaign_sends` at winner-select time — no denormalization needed.
- `campaign_recipients (lead_id, sent_at)` is the hot path for conversion attribution: `SELECT campaign_id FROM campaign_recipients WHERE lead_id = ? AND sent_at IS NOT NULL AND sent_at > $event_occurred_at - interval '7 days'`.
- `campaign_recipients (campaign_id, variant)` supports the holdout fetch in `ab-winner-select` (`WHERE campaign_id = ? AND variant = 'holdout'`) and variant-level reporting queries.
- `campaign_conversions.converted_at` is populated from the `lead.stage_changed` event's `occurred_at` field — not from `now()` at processing time — to ensure the 7-day window is anchored to when the stage change actually happened regardless of SQS processing lag.
- Bulk inserts into `campaign_recipients` are chunked at 1,000 rows per statement to avoid excessive lock contention on large campaigns.

---

## 5. Database Access & Migrations (Q5, Q6)

### 5.1 Database Client (Q5)

The Campaign Service uses **raw Knex** directly — no `@ortho/db` dependency (that package does not yet exist). Configuration:

```typescript
// src/db.ts
import Knex from 'knex'

export const db = Knex({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  searchPath: ['crm_campaigns', 'public'],
})
```

### 5.2 Migration Execution (Q6 — decision pending)

> **Note:** Q6 in the clarifying questions was left unanswered. The following records the options and defers the final decision to implementation kick-off.
>
> - **Option A (auto-migrate at startup):** `knex.migrate.latest()` before Fastify starts. Simple; safe for single-instance ECS tasks. Recommended default.
> - **Option B (separate Dockerfile step):** A `CMD ["node", "dist/migrate.js"]` runs as a separate ECS task before the main service.
> - **Option C (CI/CD pre-deploy):** Migrations run in the pipeline; service startup does not auto-migrate.
> - **Option D (docker-compose migrator):** Same image, separate `docker-compose` service for local dev.
>
> **Recommended default if unresolved at implementation start: Option A.** This is consistent with common Node.js service patterns and acceptable for a single-process Fargate deployment.

---

## 6. API

### 6.1 Campaign CRUD

```
POST   /campaigns
  body: { name, template_id, subject?, segment_id?, audience_filter?, ab_test?: { ... } }
  auth: requirePermission('campaigns:write')
  → 201 { campaign_id, status: "draft" }

GET    /campaigns
  ?status=draft,pending_review  &created_by=uuid  &limit=20  &offset=0
  auth: requirePermission('campaigns:write')
  → 200 { items: [...], total: N }
  Default (no created_by filter): all campaigns visible (Q8). created_by is a voluntary
  filter — no ownership restriction enforced by default for any role.
  Offset-based pagination is sufficient — campaigns are a bounded, staff-scoped dataset.

GET    /campaigns/:id
  auth: requirePermission('campaigns:write')
  → 200 { campaign_id, name, status, template_id, subject, segment_id,
           audience_filter, scheduled_for, ab_test: { ... },
           created_by, approved_by, approved_at, sent_at, completed_at,
           created_at, updated_at }

PATCH  /campaigns/:id
  body: any subset of campaign fields
  auth: requirePermission('campaigns:write')
  Content fields (template_id, subject, segment_id, audience_filter, ab_test)
    locked once status = 'approved' → 409 if attempted
  scheduled_for patchable by manager in approved/scheduled states without re-approval
  → 200 { campaign_id, status, updated_at }

DELETE /campaigns/:id
  auth: requirePermission('campaigns:write')
  → 200  (draft only)
  → 409  if status ≠ 'draft'
```

**A/B test config object (in POST body):**
```json
{
  "enabled": true,
  "mode": "holdout",
  "variant_a_subject": "Get 20% off your first exam",
  "variant_b_subject": "Free consultation this month",
  "test_split_pct": 10,
  "winner_delay_hours": 4
}
```

### 6.2 Approval Workflow

```
POST /campaigns/:id/submit
  auth: requirePermission('campaigns:write')
  → draft → pending_review
  → 409 if status ≠ 'draft'

POST /campaigns/:id/approve
  body: { comment?: string }
  auth: requirePermission('campaigns:write') + requirePermission('campaigns:manage')
  → pending_review → approved
  → 403 if missing campaigns:manage permission
  → 409 if status ≠ 'pending_review'

POST /campaigns/:id/reject
  body: { comment: string }   // required — rejection must explain why
  auth: requirePermission('campaigns:write') + requirePermission('campaigns:manage')
  → pending_review → draft
  → 400 if comment missing
  → 403 if missing campaigns:manage permission
  → 409 if status ≠ 'pending_review'

POST   /campaigns/:id/comments
  body: { body: string }
  auth: requirePermission('campaigns:write')
  → 201 { comment_id, author_id, body, created_at }
  // any status, any authenticated staff role

GET    /campaigns/:id/comments
  auth: requirePermission('campaigns:write')
  → 200 { comments: [...], total: N }
```

### 6.3 Scheduling & Sending

```
POST /campaigns/:id/schedule
  body: { scheduled_for: "2026-03-27T10:00:00Z" }
  auth: requirePermission('campaigns:write') + requirePermission('campaigns:manage')
  Enqueues campaign-orchestrate BullMQ delayed job; stores orchestrate_job_id.
  → approved → scheduled
  → 400 if scheduled_for missing or in the past
  → 403 if missing campaigns:manage permission
  → 409 if status ≠ 'approved'

DELETE /campaigns/:id/schedule
  auth: requirePermission('campaigns:write') + requirePermission('campaigns:manage')
  Cancels BullMQ job; sets orchestrate_job_id = NULL.
  → scheduled → approved
  → 403 if missing campaigns:manage permission
  → 409 if status ≠ 'scheduled'

POST /campaigns/:id/send-now
  auth: requirePermission('campaigns:write') + requirePermission('campaigns:manage')
  Sets status = 'sending'; enqueues campaign-orchestrate with zero delay.
  → approved → sending
  → 403 if missing campaigns:manage permission
  → 409 if status ≠ 'approved'

POST /campaigns/:id/cancel
  body: { reason?: string }
  auth: requirePermission('campaigns:write') + requirePermission('campaigns:manage')
  Cancels BullMQ jobs if enqueued (orchestrate_job_id and ab_winner_job_id).
  → any pre-sending state (draft, pending_review, approved, scheduled) → cancelled
  → 403 if missing campaigns:manage permission
  → 409 if status ∈ (sending, completed, completed_with_errors, failed, cancelled)
```

### 6.4 Diagnostics & Utilities

```
GET /campaigns/:id/sends
  auth: requirePermission('campaigns:write')
  → { sends: [{ id, location_id, variant, subject_used, status,
                total_recipients, sent_count, failed_count, completed_at }] }

GET /campaigns/:id/conversions
  auth: requirePermission('campaigns:write')
  ?limit=100  &offset=0
  → { conversions: [{ lead_id, stage_to, pipeline, converted_at }], total: N }

GET /campaigns/:id/events
  auth: requirePermission('campaigns:write')
  → { events: [{ from_status, to_status, actor_id, comment, created_at }] }

POST /campaigns/:id/test-send
  body: { to_email: string, context: { first_name: string, ... } }
  auth: requirePermission('campaigns:write')
  Renders template via Template Service; sends via POST /emails/send (transactional).
  No campaign state change. Available in any pre-sending state.
  Available to any authenticated staff role (no manager-only restriction).
  → 200 { message: "Test email sent" }

POST /campaigns/:id/spam-check
  auth: requirePermission('campaigns:write')
  Renders template sample via Template Service; calls POST /emails/spam-check.
  → 200 { score, threshold, passed, issues: [...] }
  → 409 if campaign in terminal state
```

---

## 7. BullMQ Orchestration

### 7.1 Redis Configuration (Q7)

BullMQ uses a **separate** Redis connection from `BULLMQ_REDIS_URL` — isolated from the event-bus Redis at `REDIS_URL`. This prevents BullMQ queue key collisions with EventBridge SQS stream data.

```typescript
// src/queue/connection.ts
import { Redis } from 'ioredis'
export const bullmqRedis = new Redis(process.env.BULLMQ_REDIS_URL!, { maxRetriesPerRequest: null })
```

Queue names: `campaign:orchestrate`, `campaign:ab-winner-select` (prefixed to avoid collision with other services sharing the same Redis instance).

### 7.2 `campaign-orchestrate` Worker

Fires at `scheduled_for` (or immediately for `send-now`). Each step is idempotent — on BullMQ restart re-delivery the worker skips already-completed steps.

```
1. Load campaign. If status NOT IN ('scheduled', 'sending') → ACK, exit.
   (Covers cancellation that arrived after job was enqueued.)

2. Transition: UPDATE campaigns SET status = 'sending', sent_at = COALESCE(sent_at, now())
   WHERE id = ? AND status IN ('scheduled', 'sending')
   COALESCE preserves the original sent_at on re-delivery after a crash.

── AUDIENCE RESOLUTION  (skip if audience_snapshot_id IS NOT NULL) ─────────

3. If audience_snapshot_id IS NOT NULL and the snapshot may have expired (rare: >48h outage):
   Call GET /audiences/snapshots/:audience_snapshot_id.
   If 404 (expired): SET audience_snapshot_id = NULL and continue to re-resolve.

4. Generate caller-side snapshot_id (UUID).

5. Fetch candidate leads from Lead Service in pages:
     GET /leads?contact_status=active&[location_id=...][&pipeline=...][&stage=...]
                &limit=500&offset=...
   Pre-filter extraction (Q12): Scan audience_filter JSONB ad-hoc for top-level
   { field, op, value } conditions matching known Lead Service query params
   (location_id, pipeline, stage). Apply any found as URL query parameters.
   This is an optimization — not required for correctness; Audience Engine applies
   the full filter regardless. Reduces data transfer for large, location-scoped
   deployments.
   Enrich each record with segment evaluation fields:
     { entity_id: lead_id, pipeline, stage, location_id, last_contact_at,
       opted_out, lead_source, custom_tags, ... }

6. Submit batches to Audience Engine:
     Named segment:  POST /audiences/segments/:id/evaluate { snapshot_id, entities, done }
     Inline filter:  POST /audiences/evaluate { snapshot_id, filter, entities,
                                                snapshot: true, done }
   Final batch: done: true → snapshot status → 'ready'.

7. UPDATE campaigns SET audience_snapshot_id = ? WHERE id = ?

── RECIPIENT FETCH & SEND  (per location; skip locations with existing campaign_sends rows) ──

8. GET /audiences/snapshots/:snapshot_id (paginated) → lead_ids.
   If matched_count = 0 (empty snapshot):
     UPDATE campaigns SET status = 'failed', completed_at = now()
     INSERT campaign_events (from_status: 'sending', to_status: 'failed',
                              actor_id: NULL, comment: 'empty_audience')
     ACK, exit. No campaign.sent event published.

9. Batch-fetch lead contact data from Lead Service in chunks of up to 500 IDs:
     GET /leads?ids=id1,id2,...  → { id, email, first_name, location_id,
                                      location_name, coordinator_name, referral_link }

10. Group leads by location_id.

11. For each location group:

    Skip guard: if campaign_sends row already exists for this location + variant
    (checked by email_job_ref), skip to next location (crash recovery).

    Within each location, wrap the Email Service call, campaign_sends INSERT,
    and campaign_recipients bulk INSERT in a single DB transaction to prevent
    orphan campaign_sends rows on crash.

    ── NON-A/B ──────────────────────────────────────────────────────────────

    POST /emails/campaigns/send {
      job_ref:          "{campaign_id}:{location_id}",
      location_id,
      template_id,
      subject_template: campaign.subject,
      recipients:       [{ email, context: { first_name, ... } }],
      entity_type:      "campaign",
      entity_id:        campaign_id
    }
    → 202 { job_id }
    On 422 spam_check_failed or 422 domain_not_configured:
      INSERT campaign_sends (status: 'failed', ...)
      Continue to next location. Overall terminal status determined at completion check.

    INSERT campaign_sends (location_id, variant: NULL, subject_used, email_job_id,
                           email_job_ref, total_recipients: recipients.length)
    Bulk INSERT campaign_recipients in chunks of 1,000 rows:
      (campaign_id, lead_id, email, location_id, variant: NULL, sent_at: now())

    ── A/B HOLDOUT ──────────────────────────────────────────────────────────

    Split location leads using floor rounding:
      group_size = floor(location_lead_count × test_split_pct / 100)
      test_A   = first  group_size leads → variant 'A', subject = ab_variant_a_subject
      test_B   = next   group_size leads → variant 'B', subject = ab_variant_b_subject
      holdout  = remainder              → variant 'holdout', NOT sent yet

    POST /emails/campaigns/send for A group (job_ref: "{campaign_id}:{location_id}:A")
    POST /emails/campaigns/send for B group (job_ref: "{campaign_id}:{location_id}:B")
    Both calls include entity_type: "campaign", entity_id: campaign_id.
    On 422 for either: INSERT campaign_sends (status: 'failed'), continue.

    INSERT campaign_sends rows for A and B variants.
    Bulk INSERT campaign_recipients in chunks of 1,000 rows:
      A and B groups: sent_at = now()
      holdout group:  sent_at = NULL  ← not yet sent; excluded from conversion attribution

    ── A/B FULL_SPLIT ───────────────────────────────────────────────────────

    Split 50/50: group_size = floor(location_lead_count / 2); A gets group_size, B gets rest.
    Both sent immediately. sent_at = now() for all recipients.
    No holdout rows. ab_phase set to 'complete' immediately after all location sends.

12. After all location groups processed:

    NON-A/B / FULL_SPLIT: no further action — wait for email.campaign_completed events.

    HOLDOUT only:
      UPDATE campaigns SET
        ab_phase = 'testing',
        ab_decision_at = now() + interval '{ab_winner_delay_hours} hours'
      Enqueue ab-winner-select BullMQ delayed job (delay = ab_winner_delay_hours × 3600000 ms)
      UPDATE campaigns SET ab_winner_job_id = ?
```

### 7.3 `ab-winner-select` Worker

Fires `ab_winner_delay_hours` after test groups are sent.

```
1. Load campaign.
   If status ≠ 'sending' OR ab_phase ≠ 'testing' → ACK, exit.
   (Covers campaigns cancelled after orchestration set ab_phase = 'testing'.
    status check is the primary guard; ab_phase is the secondary guard.)

2. Compute open rates:
     count_a = SUM(total_recipients) FROM campaign_sends
               WHERE campaign_id = ? AND variant = 'A'
     count_b = SUM(total_recipients) FROM campaign_sends
               WHERE campaign_id = ? AND variant = 'B'
     rate_a  = count_a > 0 ? ab_opens_a / count_a : 0
     rate_b  = count_b > 0 ? ab_opens_b / count_b : 0
     winner  = rate_a >= rate_b ? 'A' : 'B'   -- ties go to A
     -- If both count_a = 0 and count_b = 0 (degenerate case): winner defaults to 'A'.

3. winning_subject = winner = 'A' ? ab_variant_a_subject : ab_variant_b_subject

4. UPDATE campaigns SET ab_winner = winner, ab_phase = 'complete', ab_decision_at = now()

5. Fetch holdout recipients (in pages, 1,000 at a time):
   SELECT * FROM campaign_recipients
   WHERE campaign_id = ? AND variant = 'holdout'
   Group by location_id.

6. For each location (skip if campaign_sends row with this email_job_ref already exists):
   POST /emails/campaigns/send {
     job_ref:          "{campaign_id}:{location_id}:holdout",
     location_id,
     template_id,
     subject_template: winning_subject,
     recipients:       holdout leads for this location (chunked, 1,000 at a time),
     entity_type:      "campaign",
     entity_id:        campaign_id
   }
   INSERT campaign_sends (variant: 'holdout', subject_used: winning_subject, ...)
   UPDATE campaign_recipients SET sent_at = now()
   WHERE campaign_id = ? AND variant = 'holdout' AND location_id = ?
   Note: on re-run after crash, sent_at is overwritten with the recovery timestamp.
   The attribution window shift is at most the crash recovery delay (typically seconds
   to minutes) and is acceptable for v1.
```

### 7.4 Crash Recovery

- **`campaign-orchestrate`:** At each major step, checks whether output already exists (`audience_snapshot_id IS NOT NULL`, existing `campaign_sends` rows by `email_job_ref`). Skips completed steps. BullMQ re-fires un-ACKed jobs on ECS restart. The `campaign_sends` INSERT and `campaign_recipients` bulk INSERT are wrapped in a single DB transaction per location, so a mid-insert crash leaves no orphan `campaign_sends` row — the whole location is re-attempted on recovery.
- **`ab-winner-select`:** Guards on `status = 'sending'` AND `ab_phase = 'testing'` at entry. Per-location holdout send skipped if `campaign_sends` row for that `email_job_ref` already exists. `campaign_recipients.sent_at` UPDATE is idempotent (re-run overwrites with recovery timestamp — shift is negligible for v1).
- **`email_job_ref` uniqueness:** `UNIQUE` constraint on `campaign_sends.email_job_ref` means a duplicate Email Service call returns `200` with the existing job state (Email Service idempotency). Campaign Service checks the returned `job_id` and updates `campaign_sends.email_job_id` if not yet set.
- **Expired Audience Engine snapshot:** If the orchestrate worker's `audience_snapshot_id` is set but the snapshot has expired (48h TTL, possible after extended outage), `GET /audiences/snapshots/:id` returns 404. The worker clears `audience_snapshot_id` and re-resolves the audience from scratch (step 3).

---

## 8. SQS Event Handlers (Q1)

All three events are consumed via `@ortho/event-bus`:

```typescript
// src/handlers/sqs-consumer.ts  — startup wiring only
import { createBus } from '@ortho/event-bus'
import { handleEmailCampaignCompleted } from './email-campaign-completed.handler.js'
import { handleEmailOpened } from './email-opened.handler.js'
import { handleLeadStageChanged } from './lead-stage-changed.handler.js'

export function startConsumer() {
  const bus = createBus({ queueUrl: process.env.SQS_QUEUE_URL! })
  bus.subscribe('email.campaign_completed', handleEmailCampaignCompleted)
  bus.subscribe('email.opened', handleEmailOpened)
  bus.subscribe('lead.stage_changed', handleLeadStageChanged)
  bus.start()
}
```

### 8.1 `email.campaign_completed`

```
1. Extract email_job_id from payload (Email Service job UUID field: job_id).
   Look up campaign_sends row: SELECT * FROM campaign_sends WHERE email_job_id = ?
   If not found: log warn + ACK. (May be a job not owned by Campaign Service.)

2. Update campaign_sends: status, sent_count, failed_count, total_recipients, completed_at.

3. Publish campaign.sent to EventBridge via bus.publish():
   { campaign_id, location_id, sent_count, template_id, completed_at }

4. Check if campaign is fully complete:
   - If campaign.ab_phase = 'testing' → holdout not yet sent. Exit.
   - Else (ab_phase = NULL or ab_phase = 'complete'):
       SELECT COUNT(*) FROM campaign_sends
       WHERE campaign_id = ?
         AND status NOT IN ('completed','completed_with_errors','failed','cancelled')
   - If count > 0 → still in flight. Exit.

5. If all sends terminal, determine campaign terminal status:
   has_any_completion = EXISTS (
     SELECT 1 FROM campaign_sends
     WHERE campaign_id = ? AND status IN ('completed','completed_with_errors')
   )
   all_non_completion = NOT has_any_completion  -- all sends are failed or cancelled

   terminal_status =
     all_non_completion                           → 'failed'
     has_any_completion AND any failed/with_errors → 'completed_with_errors'
     else (all completed)                         → 'completed'

   If ab_mode = 'full_split' AND ab_winner IS NULL:
     -- Compute retrospective winner from open counts accumulated during the campaign.
     count_a = SUM(total_recipients) FROM campaign_sends WHERE campaign_id = ? AND variant = 'A'
     count_b = SUM(total_recipients) FROM campaign_sends WHERE campaign_id = ? AND variant = 'B'
     rate_a  = count_a > 0 ? ab_opens_a / count_a : 0
     rate_b  = count_b > 0 ? ab_opens_b / count_b : 0
     ab_winner = rate_a >= rate_b ? 'A' : 'B'  -- ties go to A; both zero → A

   UPDATE campaigns SET status = terminal_status, completed_at = now()
     [, ab_winner = ab_winner WHERE ab_mode = 'full_split' AND ab_winner IS NULL]
   INSERT campaign_events (from_status: 'sending', to_status: terminal_status, actor_id: NULL)
```

### 8.2 `email.opened`

The `email.opened` event payload carries two relevant fields:
- `campaign_job_id` — the Email Service job UUID (maps to `campaign_sends.email_job_id`)
- `entity_id` — the Campaign Service campaign UUID (populated via the `entity_type`/`entity_id` amendment)

The handler uses `campaign_job_id` for the DB lookup (to identify the variant); `entity_id` is available as a shortcut but the canonical path is the `campaign_sends` join.

```
1. Extract campaign_job_id (Email Service job UUID) from payload.
2. Look up campaign_sends by email_job_id = campaign_job_id
   → get campaign_id + variant.
   If not found: ACK (not a Campaign Service job).
3. Load campaign. If status ≠ 'sending' OR ab_phase ≠ 'testing': ACK, no-op.
   (Late opens after winner selection do not affect the decided winner.)
4. If variant = 'A': UPDATE campaigns SET ab_opens_a = ab_opens_a + 1 WHERE id = ?
   If variant = 'B': UPDATE campaigns SET ab_opens_b = ab_opens_b + 1 WHERE id = ?
   If variant = 'holdout' or NULL: ACK, no-op.
```

### 8.3 `lead.stage_changed`

The 7-day attribution window is anchored to the event's `occurred_at` timestamp — not the SQS processing time — so that late-processed events are still attributed correctly.

```
1. Extract lead_id and occurred_at from payload.
   (occurred_at is now a required field on LeadStageChangedPayload — see Section 10.)

2. SELECT campaign_id FROM campaign_recipients
   WHERE lead_id = ? AND sent_at IS NOT NULL
     AND sent_at > $occurred_at - interval '7 days'

3. For each matching campaign_id:
   INSERT INTO campaign_conversions (campaign_id, lead_id, stage_to, pipeline,
                                     converted_at)
   VALUES (?, ?, $stage_to, $pipeline, $occurred_at)
   ON CONFLICT (campaign_id, lead_id) DO NOTHING
   -- only first qualifying stage change recorded per lead per campaign
```

---

## 9. Service Layout

```
apps/crm/campaign/
├── src/
│   ├── routes/
│   │   ├── campaigns.ts          # POST/GET/PATCH/DELETE /campaigns
│   │   ├── workflow.ts           # submit, approve, reject, schedule,
│   │   │                         # unschedule, send-now, cancel
│   │   ├── comments.ts           # POST/GET /campaigns/:id/comments
│   │   └── diagnostics.ts        # sends, conversions, events,
│   │                              # spam-check, test-send
│   ├── services/
│   │   ├── campaign-service.ts   # state transition guards + validation
│   │   ├── audience-resolver.ts  # Audience Engine + Lead Service calls
│   │   │                         # → grouped recipients by location_id
│   │   │                         # includes ad-hoc pre-filter extraction (Q12)
│   │   ├── send-orchestrator.ts  # called by worker: grouping, A/B split,
│   │   │                         # Email Service calls, recipient insert
│   │   ├── ab-winner.ts          # pure fn: (opens_a, count_a, opens_b, count_b)
│   │   │                         # → 'A' | 'B'
│   │   └── conversion-tracker.ts # lead.stage_changed → 7-day attribution
│   ├── workers/
│   │   ├── campaign-orchestrate.worker.ts
│   │   └── ab-winner-select.worker.ts
│   ├── handlers/
│   │   ├── sqs-consumer.ts               # @ortho/event-bus wiring (subscribe + start)
│   │   ├── email-campaign-completed.handler.ts
│   │   ├── email-opened.handler.ts
│   │   └── lead-stage-changed.handler.ts
│   ├── repositories/
│   │   ├── campaigns.repo.ts
│   │   ├── campaign-sends.repo.ts
│   │   ├── campaign-recipients.repo.ts
│   │   ├── campaign-conversions.repo.ts
│   │   └── campaign-events.repo.ts
│   ├── events/
│   │   └── publisher.ts          # campaign.sent via bus.publish()
│   ├── queue/
│   │   └── connection.ts         # BullMQ Redis connection (BULLMQ_REDIS_URL)
│   ├── db.ts                     # raw Knex instance (DATABASE_URL)
│   ├── api.ts                    # Fastify app factory (no BullMQ, no consumer)
│   ├── worker.ts                 # BullMQ workers + sqs-consumer startup
│   └── index.ts                  # entry point for api process (starts Fastify)
├── migrations/
├── test/
│   ├── unit/
│   ├── integration/
│   └── helpers/
│       └── factories.ts          # shared test factories (Q10)
├── Dockerfile
├── package.json
└── tsconfig.json
```

**Process structure (Q9):**

Two separate ECS task definitions, same Docker image, different `CMD`:

| Process | Start Script | ECS Task | Contains |
|---|---|---|---|
| `api` | `npm run start:api` | `campaign-api` | Fastify REST API only |
| `worker` | `npm run start:worker` | `campaign-worker` | BullMQ workers + `@ortho/event-bus` consumer |

`package.json` scripts:
```json
{
  "scripts": {
    "start:api":    "node dist/index.js",
    "start:worker": "node dist/worker.js",
    "build":        "tsc",
    "dev":          "tsx watch src/index.ts",
    "dev:worker":   "tsx watch src/worker.ts",
    "typecheck":    "tsc --noEmit",
    "test":         "vitest run",
    "test:watch":   "vitest"
  }
}
```

**Runtime dependencies:**
- PostgreSQL (shared RDS cluster, `crm_campaigns` schema) — raw Knex via `DATABASE_URL`
- Redis for BullMQ — `BULLMQ_REDIS_URL` (separate from event-bus Redis)
- AWS SQS (via `@ortho/event-bus`) — dedicated queue for inbound events (`SQS_QUEUE_URL`)
- AWS EventBridge (outbound `campaign.sent` via `@ortho/event-bus` `bus.publish()`)
- Audience Engine REST
- Lead Service REST
- Email Service REST
- Template Service REST (test-send + spam-check preview only)

---

## 10. Environment Variables

| Variable | Used By | Description |
|---|---|---|
| `DATABASE_URL` | api + worker | PostgreSQL connection string |
| `REDIS_URL` | worker | `@ortho/event-bus` Redis (SQS polling) |
| `BULLMQ_REDIS_URL` | worker | BullMQ queue Redis (separate instance/DB) |
| `SQS_QUEUE_URL` | worker | Dedicated SQS queue for inbound EventBridge events |
| `EVENTBRIDGE_BUS_NAME` | worker | EventBridge bus name for `bus.publish()` |
| `AUDIENCE_ENGINE_URL` | worker | Base URL for Audience Engine REST |
| `LEAD_SERVICE_URL` | api + worker | Base URL for Lead Service REST |
| `EMAIL_SERVICE_URL` | api + worker | Base URL for Email Service REST |
| `TEMPLATE_SERVICE_URL` | api | Base URL for Template Service REST (test-send, spam-check) |
| `PORT` | api | Fastify listen port (default: 3000) |

---

## 11. `@ortho/types` Required Updates (Q3)

All four additions are in scope for this service's PRD. They must be implemented before or alongside the Campaign Service integration tests that depend on them.

### 11.1 New outbound type: `CampaignSentEvent`

```typescript
// packages/@ortho/types/src/events/campaign.ts
export interface CampaignSentPayload {
  campaign_id: string
  location_id: string
  sent_count:  number
  template_id: string
  completed_at: string   // ISO 8601
}

export interface CampaignSentEvent {
  event_type:   'campaign.sent'
  occurred_at:  string
  payload:      CampaignSentPayload
}
```

### 11.2 New inbound type: `EmailCampaignCompletedPayload`

```typescript
// packages/@ortho/types/src/events/email.ts
export interface EmailCampaignCompletedPayload {
  job_id:           string   // Email Service job UUID → maps to campaign_sends.email_job_id
  status:           'completed' | 'completed_with_errors' | 'failed' | 'cancelled'
  sent_count:       number
  failed_count:     number
  total_recipients: number
  location_id:      string
  completed_at:     string
}
```

### 11.3 New inbound type: `EmailOpenedPayload` (amendment)

Extend the existing `EmailOpenedPayload` to carry:

```typescript
// packages/@ortho/types/src/events/email.ts
export interface EmailOpenedPayload {
  // ... existing fields ...
  campaign_job_id: string   // Email Service job UUID (new)
  entity_type:     string   // e.g. "campaign" (new)
  entity_id:       string   // e.g. campaign UUID (new)
}
```

### 11.4 Amendment to `LeadStageChangedPayload`: add `occurred_at`

```typescript
// packages/@ortho/types/src/events/pipeline.ts
export interface LeadStageChangedPayload {
  lead_id:      string    // already required per Pipeline Engine spec
  stage_from:   string
  stage_to:     string
  pipeline:     string
  occurred_at:  string    // ISO 8601 — NEW FIELD (required for 7-day attribution anchor)
}
```

This field must also be confirmed in the Pipeline Engine spec (see Section 13 — Pending Amendments).

---

## 12. Testing Strategy

### Unit Tests (Vitest — pure functions, no I/O)

- **`ab-winner.ts`** — higher open rate wins; tie → A; zero recipients on one side → other wins; both zero → A (no division by zero)
- **`send-orchestrator.ts` split logic** — `test_split_pct=10`, 100 leads: A=10, B=10, holdout=80; floor rounding on non-divisible inputs (e.g. 101 leads: A=10, B=10, holdout=81); full_split: `floor(n/2)` for A, rest for B; holdout rows inserted with `sent_at = NULL`
- **`campaign-service.ts` transition guards** — all valid transitions pass; invalid transitions throw; content fields locked in `approved` state returns `409`; `reject` without comment returns `400`
- **`audience-resolver.ts`** — pagination loop calls Lead Service correct number of times; batch submission sets `done: true` on final batch only; Audience Engine `4xx` surfaces as orchestration failure

### Test Fixtures (Q10)

Shared factory functions live in `test/helpers/factories.ts` — no external `@ortho/testing` dependency. Factories cover: campaign records at each status, `campaign_sends` rows, `campaign_recipients` rows, lead stubs, event payloads (`email.campaign_completed`, `email.opened`, `lead.stage_changed`).

### Integration Tests (Vitest + real Postgres + real Redis; external services mocked via HTTP interceptor)

**Non-A/B happy path:**
Create → submit → approve → schedule → BullMQ fires → audience resolved → recipients fetched → Email Service called once per location → `email.campaign_completed` received → status = `completed`, `campaign.sent` published per location, `campaign_events` row written.

**A/B holdout happy path:**
Full flow through orchestration → `ab_phase = 'testing'` → `ab-winner-select` fires after delay → winner determined → holdout submitted → second `email.campaign_completed` per location → status = `completed`. Assert `campaign_recipients` holdout rows have `sent_at = NULL` before winner fires and `sent_at IS NOT NULL` after.

**A/B full_split:**
Both variants sent immediately; `ab_phase = 'complete'` set at orchestration time; campaign completes when both email jobs finish; `ab_winner` set from open counts at completion.

**Approval workflow:**
`draft → submit → reject with comment → draft` — comment present in `campaign_comments`, transition in `campaign_events`. Reject without comment → `400`. Cancel from `pending_review` → `cancelled`.

**Unschedule:**
`approved → schedule → unschedule → approved` — BullMQ job cancelled, `orchestrate_job_id = NULL`, campaign not sent.

**Conversion attribution:**
- Lead receives campaign (`sent_at = T`); `lead.stage_changed` with `occurred_at = T + 3 days` → conversion recorded with `converted_at = T + 3 days`.
- `lead.stage_changed` with `occurred_at = T + 8 days` → no conversion (outside 7-day window).
- Second `lead.stage_changed` within 7 days → `ON CONFLICT DO NOTHING`, only first recorded.
- Holdout lead with `sent_at = NULL` → `lead.stage_changed` → no conversion.
- `lead.stage_changed` processed late (SQS lag of 2 days) but `occurred_at` is within 7 days of `sent_at` → conversion IS recorded (event timestamp used, not processing time).

**A/B open tracking:**
- `email.opened` during `ab_phase = 'testing'`, variant A → `ab_opens_a` incremented atomically.
- `email.opened` after `ab_phase = 'complete'` → no-op (guard: `ab_phase ≠ 'testing'` → exit).
- `email.opened` when `status ≠ 'sending'` (cancelled campaign) → no-op.
- `email.opened` for variant `holdout` → no-op.

**Cancellation:**
- Cancel `scheduled` campaign → BullMQ job removed → status `cancelled`.
- `campaign-orchestrate` fires after cancellation → status check at step 1 → ACK, exit cleanly.
- Cancel in `sending` state → `409`.

**Cancel during A/B testing phase:**
- Campaign in `sending` with `ab_phase = 'testing'` → cancel → `409` (sending is blocked).
- `ab-winner-select` fires for a campaign where status has been manually set to `cancelled` → status ≠ 'sending' guard exits cleanly.

**Multi-location send:**
Audience with leads at 3 locations → orchestrator makes 3 `POST /emails/campaigns/send` calls → 3 `campaign_sends` rows → 3 `email.campaign_completed` events → 3 `campaign.sent` publishes → campaign `completed`.

**Empty audience:**
Audience Engine returns snapshot with `matched_count = 0` → campaign transitions to `failed` with `comment: 'empty_audience'` in `campaign_events` → no Email Service calls made.

**Crash recovery — `campaign-orchestrate`:**
Insert campaign in `sending` with `audience_snapshot_id` already set + 2 of 3 `campaign_sends` rows present (with corresponding `campaign_recipients`); fire worker → assert only missing location send submitted; no duplicate Audience Engine calls; no duplicate `campaign_recipients` rows.

**Crash recovery — atomic transaction:**
Simulate crash between `campaign_sends` INSERT and `campaign_recipients` INSERT (by rolling back mid-transaction); re-run worker → assert full location is re-submitted cleanly with no orphan `campaign_sends` row.

**Spam check gate:**
Email Service returns `422 spam_check_failed` for one location → that `campaign_sends` row has `status = 'failed'` → if all locations fail → campaign status = `failed`.

**Terminal status — all cancelled:**
All `campaign_sends` rows have `status = 'cancelled'` → campaign terminal status = `failed` (no completions).

**`completed_with_errors`:**
2 locations succeed, 1 fails → campaign status = `completed_with_errors`; all 3 `campaign.sent` events still published for succeeded locations.

**Expired snapshot recovery:**
Insert campaign in `sending` with `audience_snapshot_id` set but no snapshot in Audience Engine (simulated expiry); fire worker → asserts `audience_snapshot_id` cleared → audience re-resolved → send completes.

### Contract Tests (Q11)

Implemented with **TypeBox `Value.Check()`** in Vitest. Each contract defines a `TSchema` for the expected payload shape; tests call `Value.Check(schema, payload)` and assert `true`.

| Direction | Contract |
|---|---|
| Outbound | `POST /audiences/segments/:id/evaluate` payload shape matches Audience Engine spec |
| Outbound | `POST /audiences/evaluate` inline shape (`snapshot: true`) |
| Outbound | `GET /leads` query params (with pre-filter fields) + response shape matches Lead Service spec |
| Outbound | `GET /leads?ids=...` batch endpoint matches Lead Service spec amendment |
| Outbound | `POST /emails/campaigns/send` with `entity_type` + `entity_id` fields (Email Service spec amendment) |
| Outbound | `campaign.sent` EventBridge payload validated against `CampaignSentEvent` TypeBox schema; `sent_count` field present |
| Inbound | `email.campaign_completed` payload: `job_id`, `status`, `sent_count`, `failed_count`, `total_recipients`, `location_id` |
| Inbound | `email.opened` payload: `campaign_job_id` (Email Service job UUID) + `entity_id` (campaign UUID) both present |
| Inbound | `lead.stage_changed` payload: `lead_id`, `stage_to`, `pipeline`, `occurred_at` all present |

---

## 13. Implementation Phasing (Q13)

The Campaign Service is built in **three phases**:

### Phase 1 — CRUD + Approval Workflow

- Campaign CRUD (POST/GET/PATCH/DELETE)
- Submit / approve / reject / comments
- `@ortho/auth-middleware` amendment (`campaigns:manage` permission)
- `@ortho/types` additions (all four — Q3)
- DB schema + migrations
- Unit tests: transition guards
- Integration tests: approval workflow scenarios

### Phase 2 — Orchestration + Non-A/B Send

- BullMQ queue setup (`campaign:orchestrate`)
- `campaign-orchestrate` worker (non-A/B path only)
- `audience-resolver.ts` (Audience Engine + Lead Service + pre-filter extraction)
- `send-orchestrator.ts` (non-A/B grouping + Email Service calls)
- `@ortho/event-bus` consumer wiring (`sqs-consumer.ts`) for `email.campaign_completed`
- `publisher.ts` for `campaign.sent`
- Schedule / send-now / cancel / unschedule routes
- Process structure: `api.ts` + `worker.ts` + separate start scripts
- Crash recovery (idempotency guards, transaction scope)
- Integration tests: non-A/B happy path, empty audience, crash recovery, multi-location

### Phase 3 — A/B Testing + Conversion Attribution + Diagnostics

- A/B holdout and full_split orchestration paths
- `ab-winner-select` worker
- `@ortho/event-bus` consumer handlers for `email.opened` + `lead.stage_changed`
- `conversion-tracker.ts`
- Diagnostics routes (sends, conversions, events, test-send, spam-check)
- Integration tests: A/B holdout, full_split, attribution, open tracking, diagnostics
- Contract tests (all 9)

---

## 14. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Event consumption | `@ortho/event-bus` `bus.subscribe()` + `bus.start()` (Q1) | Consistent with all other services; `sqs-consumer.ts` is startup wiring only. |
| Event publishing | `@ortho/event-bus` `bus.publish()` (Q2) | Single bus instance handles both inbound subscriptions and outbound publish. |
| Auth-middleware amendment | Add `campaigns:manage` permission; use `requirePermission` stacking (Q4) | Distinguishes manager-only actions without relying on role-name strings in route handlers. |
| Database client | Raw Knex from `DATABASE_URL` (Q5) | `@ortho/db` package does not yet exist; no blocking dependency. |
| BullMQ Redis | Separate `BULLMQ_REDIS_URL` (Q7) | Isolates queue storage from event-bus stream keys; prevents key collisions. |
| Campaign list visibility | All campaigns visible by default; `created_by` is a voluntary filter (Q8) | Marketing Staff are a small, trusted team; no ownership restriction needed. |
| Process structure | Two process types (`api` + `worker`) with separate `package.json` start scripts (Q9) | Independent ECS scaling; API can scale horizontally without duplicating BullMQ workers. |
| Test fixtures | `test/helpers/factories.ts` within service (Q10) | `@ortho/testing` package does not yet exist; inline factories are sufficient and self-contained. |
| Contract tests | TypeBox `Value.Check()` in Vitest (Q11) | Catches payload shape errors at test time; consistent with the `@sinclair/typebox` already used for validation throughout the stack. |
| Audience pre-filtering | Ad-hoc JSONB inspection for known Lead Service query params (Q12) | Optimization not required for correctness; reduces data transfer for location-scoped segments without adding a full query-compiler. |
| Implementation phases | Three phases: CRUD+Approval → Orchestration+Send → A/B+Attribution+Diagnostics (Q13) | Each phase delivers a testable, integrated slice; A/B complexity is isolated to Phase 3. |
| Send orchestration mechanism | BullMQ delayed jobs | Precise timing, crash-safe via Redis persistence, consistent with Nurturing Engine patterns. Audience is resolved at send time (not schedule time) — no stale recipient lists. |
| A/B testing — default mode | Holdout (test/decide/send) | Maximises impact of winner: only a small test cohort receives the non-winning variant. Full-split mode available for campaigns where holdout is not desired. |
| A/B split rounding | `floor(n × pct / 100)` for each test group; remainder to holdout | Deterministic, unambiguous for any audience size. |
| Conversion attribution | `occurred_at` anchor, not SQS processing time | Late-processed events are still attributed correctly within the 7-day window. |
| Empty audience handling | Campaign transitions to `failed` immediately | Prevents stuck `sending` state with no completion events. |
| `campaign.sent` `sent_count` | Carries recipient count from Email Service job | Analytics `CampaignSentHandler` increments `metrics_campaigns_daily.sent` by `sent_count` (not by 1). |

---

## 15. Pending Amendments to Other Specs

| Spec | Amendment Required |
|---|---|
| **`@ortho/auth-middleware`** | Add `campaigns:manage` permission to `ROLE_PERMISSIONS`; grant to `marketing_manager` and `super_admin` only. |
| **`@ortho/types`** | Add `CampaignSentPayload`/`CampaignSentEvent`; add `EmailCampaignCompletedPayload`; extend `EmailOpenedPayload` with `campaign_job_id`, `entity_type`, `entity_id`; add `occurred_at` to `LeadStageChangedPayload`. |
| **Email Service spec** | Add `entity_type` and `entity_id` fields to `POST /emails/campaigns/send` request body. Passed through to `email.opened`, `email.clicked`, `email.campaign_completed` EventBridge events. |
| **Lead Service spec** | Add `ids` query parameter (comma-separated UUIDs) to `GET /leads` for batch contact data fetch (Section 7.2, step 9). |
| **Analytics spec** | Document `CampaignSentHandler` increments `metrics_campaigns_daily.sent` by `payload.sent_count` (not by 1). Add as a second exception in the idempotency section (alongside `AdSpendSyncedHandler`). |
| **Analytics spec** | Confirm `campaign.sent` payload shape: `{ campaign_id, location_id, sent_count, template_id, completed_at }`. |
| **Pipeline Engine spec** | Confirm `lead_id` and `occurred_at` are required fields in `lead.stage_changed` payload. |
| **Arch doc event table** | Add Campaign Service as subscriber to `email.opened`, `lead.stage_changed`, and `email.campaign_completed`. |
