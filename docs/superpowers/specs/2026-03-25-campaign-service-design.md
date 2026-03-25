# Campaign Service — Design Spec

**Date:** 2026-03-25
**Status:** Draft
**Scope:** Product-layer Campaign Service — email broadcast campaign lifecycle, comment-based approval workflow, BullMQ send orchestration, A/B holdout testing, 7-day conversion attribution.

---

## 1. Overview

The Campaign Service is a **product-layer service** (`apps/crm/campaign`, schema `crm_campaigns`) that owns the full email broadcast campaign lifecycle: authoring, approval, scheduling, send orchestration, A/B winner selection, and conversion attribution.

**Core responsibilities:**
- Campaign CRUD with comment-based approval workflow (`draft → pending_review → approved → scheduled → sending → completed`)
- Audience resolution: calls Audience Engine for segment evaluation, Lead Service for recipient data
- Send orchestration: groups recipients by `location_id`, calls `POST /emails/campaigns/send` once per location
- A/B testing: holdout model (configurable test split %) with auto winner selection after a configurable delay, plus full-split mode (no holdout)
- Conversion attribution: subscribes to `lead.stage_changed` events via SQS, records conversions within a 7-day window
- Publishes `campaign.sent` event per `(campaign_id, location_id)` when Email Service reports send completion

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
│  REST API (Fastify)                                       │
│  ├── Campaign CRUD + review comments                      │
│  ├── Approval workflow (submit / approve / reject)        │
│  └── Schedule / send-now / cancel                         │
│                                                           │
│  BullMQ Workers (Redis)                                   │
│  ├── campaign-orchestrate  ──► audience → leads → send   │
│  └── ab-winner-select  ──────► pick winner → holdout     │
│                                                           │
│  SQS Consumer                                             │
│  ├── email.campaign_completed  → update campaign state   │
│  ├── email.opened              → A/B open counter        │
│  └── lead.stage_changed        → conversion attribution  │
└──────────────────────────────────────────────────────────┘
          │               │                │
   Audience Engine    Lead Service    Email Service
   (snapshot eval)   (email+context)  (bulk send jobs)
```

**Platform services consumed:**
- **Audience Engine** — `POST /audiences/segments/:id/evaluate`, `POST /audiences/evaluate` (inline)
- **Lead Service** — `GET /leads` (fetch recipient contact data + segment evaluation fields)
- **Email Service** — `POST /emails/campaigns/send` (one call per location per send phase), `POST /emails/spam-check`, `POST /emails/send` (test-send only)
- **Template Service** — `POST /templates/render` (test-send and on-demand spam check only; Email Service renders per-recipient for bulk sends)

**EventBridge subscriptions (dedicated SQS queue):**
- `email.campaign_completed` — Email Service signals a bulk send job finished
- `email.opened` — track per-variant opens for A/B winner selection
- `lead.stage_changed` — 7-day conversion attribution

**EventBridge events published:**
- `campaign.sent` — one per `(campaign_id, location_id)` when Email Service reports job completion; carries `campaign_id`, `location_id`, `sent_count`. Subscribed by Analytics Service (`CampaignSentHandler` → `metrics_campaigns_daily.sent`).

**Multi-location handling:** A campaign's segment may match leads across multiple locations. Since Email Service requires one `location_id` per send job, the orchestrate worker groups recipients by `location_id` and calls `POST /emails/campaigns/send` once per location. Each location send is tracked as a separate `campaign_sends` row.

**Email Service spec amendment required:** `POST /emails/campaigns/send` needs `entity_type` + `entity_id` fields (same as the transactional `POST /emails/send` already has) so that `email.opened` / `email.clicked` EventBridge events carry `entity_type: "campaign"` + `entity_id: "{campaign_id}"`. This enables Analytics Service to populate `metrics_campaigns_daily.opened` / `.clicked` and enables the Campaign Service `email.opened` handler to resolve the campaign without a reverse-lookup.

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

Any pre-sending state → cancelled  (Marketing Manager only)
scheduled → approved  via [unschedule]  (cancels BullMQ job, clears orchestrate_job_id)
```

### 3.2 A/B Sub-phases

Tracked in `campaigns.ab_phase` (only relevant while `status = 'sending'` and `ab_enabled = true`):

| `ab_phase` | Meaning |
|---|---|
| `null` | Non-A/B campaign, or A/B full_split (all sent at once, no holdout) |
| `testing` | Test groups A and B sent; `ab-winner-select` job is pending |
| `complete` | Winner selected; holdout send submitted (holdout mode) or all sends done (full_split) |

**Holdout mode flow:**
1. Orchestrate worker sends test groups A and B → sets `ab_phase = 'testing'` → enqueues `ab-winner-select` job with `winner_delay_hours` delay
2. `ab-winner-select` fires → computes open rates → sets `ab_winner` + `ab_phase = 'complete'` → submits holdout recipients with winning subject
3. `email.campaign_completed` arrives for holdout → campaign reaches terminal status

**Full-split mode flow:**
1. Orchestrate worker sends all recipients split 50/50 between A and B (two Email Service jobs per location)
2. `ab_phase = 'complete'` set immediately (no holdout)
3. Winner determined retrospectively from open counts when both jobs complete — for reporting only

### 3.3 Permission Matrix

| Action | Marketing Staff | Marketing Manager |
|---|---|---|
| Create / edit draft | ✓ | ✓ |
| Submit for review | ✓ | ✓ |
| Add comments | ✓ | ✓ |
| Approve / reject | — | ✓ |
| Schedule / send-now / cancel | — | ✓ |
| Re-schedule (`scheduled_for` only) | — | ✓ (no re-approval needed) |

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
  orchestrate_job_id    text,           -- BullMQ job ID (for cancellation on unschedule)

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

-- Lead → campaign mapping for 7-day conversion attribution
-- Holdout leads are inserted at orchestration time with sent_at = NULL (not yet sent).
-- sent_at is set when holdout send is submitted by ab-winner-select worker.
-- Conversion tracking only considers rows WHERE sent_at IS NOT NULL.
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
  converted_at  timestamptz NOT NULL,
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
CREATE INDEX ON campaign_sends (email_job_id);
CREATE INDEX ON campaign_recipients (lead_id, sent_at);  -- conversion attribution hot path
CREATE INDEX ON campaign_recipients (campaign_id);
CREATE INDEX ON campaign_conversions (campaign_id);
CREATE INDEX ON campaign_events (campaign_id);
CREATE INDEX ON campaign_comments (campaign_id);
```

**Notes:**
- `ab_opens_a` / `ab_opens_b` are updated atomically: `UPDATE campaigns SET ab_opens_a = ab_opens_a + 1 WHERE id = ?`. Open rate denominator is computed from `campaign_sends` at winner-select time — no denormalization needed.
- `campaign_recipients (lead_id, sent_at)` is the hot path for conversion attribution: on every `lead.stage_changed` event, `SELECT campaign_id FROM campaign_recipients WHERE lead_id = ? AND sent_at IS NOT NULL AND sent_at > now() - interval '7 days'`.
- `campaign_recipients` rows for holdout leads are written at orchestration time with `sent_at = NULL`. The `email.opened` handler and conversion tracker both guard on `sent_at IS NOT NULL`.

---

## 5. API

### 5.1 Campaign CRUD

```
POST   /campaigns
  body: { name, template_id, subject?, segment_id?, audience_filter?, ab_test?: { ... } }
  → 201 { campaign_id, status: "draft" }

GET    /campaigns
  ?status=draft,pending_review  &created_by=uuid  &limit=20  &offset=0
  → 200 { items: [...], total: N }

GET    /campaigns/:id
  → 200 { campaign_id, name, status, template_id, subject, segment_id,
           audience_filter, scheduled_for, ab_test: { ... },
           created_by, approved_by, approved_at, sent_at, completed_at,
           created_at, updated_at }

PATCH  /campaigns/:id
  body: any subset of campaign fields
  Content fields (template_id, subject, segment_id, audience_filter, ab_test)
    locked once status = 'approved' → 409 if attempted
  scheduled_for patchable by manager in approved/scheduled states without re-approval
  → 200 { campaign_id, status, updated_at }

DELETE /campaigns/:id
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

### 5.2 Approval Workflow

```
POST /campaigns/:id/submit
  → draft → pending_review
  → 409 if status ≠ 'draft'

POST /campaigns/:id/approve
  body: { comment?: string }
  → pending_review → approved
  → 403 if not Marketing Manager
  → 409 if status ≠ 'pending_review'

POST /campaigns/:id/reject
  body: { comment: string }   // required
  → pending_review → draft
  → 400 if comment missing
  → 403 if not Marketing Manager
  → 409 if status ≠ 'pending_review'

POST   /campaigns/:id/comments
  body: { body: string }
  → 201 { comment_id, author_id, body, created_at }

GET    /campaigns/:id/comments
  → 200 { comments: [...], total: N }
```

### 5.3 Scheduling & Sending

```
POST /campaigns/:id/schedule
  body: { scheduled_for: "2026-03-27T10:00:00Z" }
  Enqueues campaign-orchestrate BullMQ delayed job; stores orchestrate_job_id.
  → approved → scheduled
  → 400 if scheduled_for missing or in the past
  → 403 if not Marketing Manager
  → 409 if status ≠ 'approved'

DELETE /campaigns/:id/schedule
  Cancels BullMQ job; clears orchestrate_job_id.
  → scheduled → approved
  → 403 if not Marketing Manager
  → 409 if status ≠ 'scheduled'

POST /campaigns/:id/send-now
  Sets status = 'sending'; enqueues campaign-orchestrate with zero delay.
  → approved → sending
  → 403 if not Marketing Manager
  → 409 if status ≠ 'approved'

POST /campaigns/:id/cancel
  body: { reason?: string }
  Cancels BullMQ job if enqueued (orchestrate_job_id or ab_winner_job_id).
  → any pre-sending state → cancelled
  → 403 if not Marketing Manager
  → 409 if status ∈ (sending, completed, completed_with_errors, failed, cancelled)
```

### 5.4 Diagnostics & Utilities

```
GET /campaigns/:id/sends
  → { sends: [{ id, location_id, variant, subject_used, status,
                total_recipients, sent_count, failed_count, completed_at }] }

GET /campaigns/:id/conversions
  → { conversions: [{ lead_id, stage_to, pipeline, converted_at }], total: N }

GET /campaigns/:id/events
  → { events: [{ from_status, to_status, actor_id, comment, created_at }] }

POST /campaigns/:id/test-send
  body: { to_email: string, context: { first_name: string, ... } }
  Renders template via Template Service; sends via POST /emails/send (transactional).
  No campaign state change. Available in any pre-sending state.
  → 200 { message: "Test email sent" }

POST /campaigns/:id/spam-check
  Renders template sample via Template Service; calls POST /emails/spam-check.
  → 200 { score, threshold, passed, issues: [...] }
  → 409 if campaign in terminal state
```

---

## 6. BullMQ Orchestration

### 6.1 `campaign-orchestrate` Worker

Fires at `scheduled_for` (or immediately for `send-now`). Each step is idempotent — on BullMQ restart re-delivery the worker skips already-completed steps.

```
1. Load campaign. If status NOT IN ('scheduled', 'sending') → ACK, exit.

2. Transition: UPDATE campaigns SET status = 'sending', sent_at = now()
   WHERE id = ? AND status IN ('scheduled', 'sending')

── AUDIENCE RESOLUTION  (skip if audience_snapshot_id IS NOT NULL) ─────────

3. Generate caller-side snapshot_id (UUID).

4. Fetch candidate leads from Lead Service in pages (GET /leads?contact_status=active&limit=500):
   Enrich each record with segment evaluation fields:
     { entity_id: lead_id, pipeline, stage, location_id, last_contact_at,
       opted_out, lead_source, custom_tags, ... }

5. Submit batches to Audience Engine:
     Named segment:  POST /audiences/segments/:id/evaluate { snapshot_id, entities, done }
     Inline filter:  POST /audiences/evaluate { snapshot_id, filter, entities,
                                                snapshot: true, done }
   Final batch: done: true → snapshot status → 'ready'.

6. UPDATE campaigns SET audience_snapshot_id = ? WHERE id = ?

── RECIPIENT FETCH & SEND  (per location; skip locations with existing campaign_sends rows) ──

7. GET /audiences/snapshots/:snapshot_id  (paginated)  → lead_ids.

8. Batch-fetch lead contact data from Lead Service:
   GET /leads?ids=...  → { id, email, first_name, location_id,
                            location_name, coordinator_name, referral_link }

9. Group leads by location_id.

10. For each location group (skip if campaign_sends row already exists for this location+variant):

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

    INSERT campaign_sends (location_id, variant: NULL, subject_used, email_job_id,
                           email_job_ref, total_recipients: recipients.length)
    Bulk INSERT campaign_recipients (campaign_id, lead_id, email, location_id,
                                     variant: NULL, sent_at: now())

    ── A/B HOLDOUT ──────────────────────────────────────────────────────────

    Split location leads:
      test_A  = first  test_split_pct%  → variant 'A', subject = ab_variant_a_subject
      test_B  = next   test_split_pct%  → variant 'B', subject = ab_variant_b_subject
      holdout = remainder               → variant 'holdout', NOT sent yet

    POST /emails/campaigns/send for A group (job_ref: "{campaign_id}:{location_id}:A")
    POST /emails/campaigns/send for B group (job_ref: "{campaign_id}:{location_id}:B")
    Both calls include entity_type: "campaign", entity_id: campaign_id

    INSERT campaign_sends rows for A and B variants.
    Bulk INSERT campaign_recipients:
      A and B groups: sent_at = now()
      holdout group:  sent_at = NULL  ← not yet sent; excluded from conversion attribution

    ── A/B FULL_SPLIT ───────────────────────────────────────────────────────

    Split 50/50 into A and B. Both sent immediately (same as holdout A+B above).
    No holdout rows. sent_at = now() for all recipients.
    ab_phase set to 'complete' immediately after sends submitted.

11. After all location groups processed:

    NON-A/B / FULL_SPLIT: no further action — wait for email.campaign_completed events.

    HOLDOUT only:
      UPDATE campaigns SET
        ab_phase = 'testing',
        ab_decision_at = now() + interval '{ab_winner_delay_hours} hours'
      Enqueue ab-winner-select BullMQ delayed job (delay = ab_winner_delay_hours * 3600000 ms)
      UPDATE campaigns SET ab_winner_job_id = ?
```

### 6.2 `ab-winner-select` Worker

Fires `ab_winner_delay_hours` after test groups are sent.

```
1. Load campaign. If ab_phase ≠ 'testing' → ACK, exit.
   (Campaign may have been cancelled; ab_phase check is the guard.)

2. Compute open rates:
     count_a = SUM(total_recipients) FROM campaign_sends
               WHERE campaign_id = ? AND variant = 'A'
     count_b = SUM(total_recipients) FROM campaign_sends
               WHERE campaign_id = ? AND variant = 'B'
     rate_a  = ab_opens_a / count_a
     rate_b  = ab_opens_b / count_b
     winner  = rate_a >= rate_b ? 'A' : 'B'   -- ties go to A

3. winning_subject = winner = 'A' ? ab_variant_a_subject : ab_variant_b_subject

4. UPDATE campaigns SET ab_winner = winner, ab_phase = 'complete', ab_decision_at = now()

5. Fetch holdout recipients:
   SELECT * FROM campaign_recipients
   WHERE campaign_id = ? AND variant = 'holdout'
   Group by location_id.

6. For each location (skip if campaign_sends row with variant='holdout' already exists):
   POST /emails/campaigns/send {
     job_ref:          "{campaign_id}:{location_id}:holdout",
     location_id,
     template_id,
     subject_template: winning_subject,
     recipients:       holdout leads for this location,
     entity_type:      "campaign",
     entity_id:        campaign_id
   }
   INSERT campaign_sends (variant: 'holdout', subject_used: winning_subject, ...)
   UPDATE campaign_recipients SET sent_at = now()
   WHERE campaign_id = ? AND variant = 'holdout' AND location_id = ?
```

### 6.3 Crash Recovery

- **`campaign-orchestrate`:** At each major step, checks whether output already exists (`audience_snapshot_id IS NOT NULL`, existing `campaign_sends` rows by `email_job_ref`). Skips completed steps. BullMQ re-fires un-ACKed jobs on ECS restart.
- **`ab-winner-select`:** Guards on `ab_phase = 'testing'` at entry. Per-location holdout send skipped if `campaign_sends` row for that `email_job_ref` already exists. `campaign_recipients.sent_at` update (`SET sent_at = now()`) is safe to re-run.
- **`email_job_ref` uniqueness:** `UNIQUE` constraint on `campaign_sends.email_job_ref` means a duplicate Email Service call returns `200` with the existing job state (Email Service idempotency). Campaign Service checks the returned `job_id` and updates `campaign_sends.email_job_id` if not yet set.

---

## 7. SQS Event Handlers

All three events arrive on a **single dedicated SQS queue** (standard EventBridge fan-out pattern used across all services).

### 7.1 `email.campaign_completed`

```
1. Look up campaign_sends row by email_job_id (payload field: job_id from Email Service).
   If not found: log warn + ACK. (May be a job not owned by Campaign Service.)

2. Update campaign_sends: status, sent_count, failed_count, total_recipients, completed_at.

3. Publish campaign.sent to EventBridge:
   { campaign_id, location_id, sent_count, template_id, completed_at }

4. Check if campaign is fully complete:
   - If campaign.ab_phase = 'testing' → holdout not yet sent. Exit.
   - Else: SELECT COUNT(*) FROM campaign_sends
           WHERE campaign_id = ?
             AND status NOT IN ('completed','completed_with_errors','failed','cancelled')
   - If count > 0 → still in flight. Exit.

5. If all sends terminal, determine campaign terminal status:
     all failed                    → 'failed'
     any failed or with_errors     → 'completed_with_errors'
     else                          → 'completed'
   UPDATE campaigns SET status = ?, completed_at = now()
   INSERT campaign_events (from_status: 'sending', to_status: ?, actor_id: NULL)
```

### 7.2 `email.opened`

```
1. Extract campaign_job_id from payload (Email Service job UUID).
2. Look up campaign_sends by email_job_id → get campaign_id + variant.
   If not found: ACK (not a Campaign Service job).
3. Load campaign. If ab_phase ≠ 'testing': ACK, no-op.
   (Late opens after winner selection do not affect the decided winner.)
4. If variant = 'A': UPDATE campaigns SET ab_opens_a = ab_opens_a + 1 WHERE id = ?
   If variant = 'B': UPDATE campaigns SET ab_opens_b = ab_opens_b + 1 WHERE id = ?
   If variant = 'holdout' or NULL: ACK, no-op.
```

### 7.3 `lead.stage_changed`

```
1. Extract lead_id from payload.
2. SELECT campaign_id FROM campaign_recipients
   WHERE lead_id = ? AND sent_at IS NOT NULL
     AND sent_at > now() - interval '7 days'

3. For each matching campaign_id:
   INSERT INTO campaign_conversions (campaign_id, lead_id, stage_to, pipeline, converted_at)
   ON CONFLICT (campaign_id, lead_id) DO NOTHING
   -- only first qualifying stage change recorded per lead per campaign
```

---

## 8. Service Layout

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
│   │   ├── send-orchestrator.ts  # called by worker: grouping, A/B split,
│   │   │                         # Email Service calls, recipient insert
│   │   ├── ab-winner.ts          # pure fn: (opens_a, count_a, opens_b, count_b)
│   │   │                         # → 'A' | 'B'
│   │   └── conversion-tracker.ts # lead.stage_changed → 7-day attribution
│   ├── workers/
│   │   ├── campaign-orchestrate.worker.ts
│   │   └── ab-winner-select.worker.ts
│   ├── handlers/
│   │   ├── sqs-consumer.ts       # polls SQS, routes by event_type
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
│   │   └── publisher.ts          # campaign.sent EventBridge publish
│   └── index.ts
├── migrations/
├── test/
├── Dockerfile
├── package.json
└── tsconfig.json
```

**Runtime dependencies:**
- PostgreSQL (shared RDS cluster, `crm_campaigns` schema)
- Redis (BullMQ — `campaign-orchestrate` + `ab-winner-select` queues)
- AWS SQS (EventBridge fan-out — dedicated queue for `email.campaign_completed`, `email.opened`, `lead.stage_changed`)
- AWS EventBridge (outbound — `campaign.sent`)
- Audience Engine REST
- Lead Service REST
- Email Service REST
- Template Service REST (test-send + spam-check preview only)

---

## 9. Testing Strategy

### Unit Tests (Vitest — pure functions, no I/O)

- **`ab-winner.ts`** — higher open rate wins; tie → A; zero recipients on one side → other wins; both zero → A
- **`send-orchestrator.ts` split logic** — `test_split_pct=10`, 100 leads: A=10, B=10, holdout=80; rounding on odd-count inputs; full_split always 50/50; holdout rows inserted with `sent_at = NULL`
- **`campaign-service.ts` transition guards** — all valid transitions pass; invalid transitions throw; content fields locked in `approved` state returns `409`; `reject` without comment returns `400`
- **`audience-resolver.ts`** — pagination loop calls Lead Service correct number of times; batch submission sets `done: true` on final batch only; Audience Engine `4xx` surfaces as orchestration failure

### Integration Tests (Vitest + real Postgres + real Redis; external services mocked via HTTP interceptor)

**Non-A/B happy path:**
Create → submit → approve → schedule → BullMQ fires → audience resolved → recipients fetched → Email Service called once per location → `email.campaign_completed` received → status = `completed`, `campaign.sent` published per location, `campaign_events` row written.

**A/B holdout happy path:**
Full flow through orchestration → `ab_phase = 'testing'` → `ab-winner-select` fires after delay → winner determined → holdout submitted → second `email.campaign_completed` per location → status = `completed`. Assert `campaign_recipients` holdout rows have `sent_at = NULL` before winner fires and `sent_at = <timestamp>` after.

**A/B full_split:**
Both variants sent immediately; `ab_phase = 'complete'` set at orchestration time; campaign completes when both email jobs finish; `ab_winner` set from open counts.

**Approval workflow:**
`draft → submit → reject with comment → draft` — comment present in `campaign_comments`, transition in `campaign_events`. Reject without comment → `400`.

**Unschedule:**
`approved → schedule → unschedule → approved` — BullMQ job cancelled, `orchestrate_job_id` cleared, campaign not sent.

**Conversion attribution:**
- Lead receives campaign (`sent_at = T`); `lead.stage_changed` at `T + 3 days` → conversion recorded.
- `lead.stage_changed` at `T + 8 days` → no conversion (outside 7-day window).
- Second `lead.stage_changed` within 7 days → `ON CONFLICT DO NOTHING`, only first recorded.
- Holdout lead with `sent_at = NULL` → `lead.stage_changed` → no conversion.

**A/B open tracking:**
- `email.opened` during `ab_phase = 'testing'`, variant A → `ab_opens_a` incremented atomically.
- `email.opened` after `ab_phase = 'complete'` → no-op.
- `email.opened` for variant `holdout` → no-op.

**Cancellation:**
- Cancel `scheduled` campaign → BullMQ job removed → status `cancelled`.
- `campaign-orchestrate` fires after cancellation → status check at step 1 → ACK, exit cleanly.
- Cancel in `sending` state → `409`.

**Multi-location send:**
Audience with leads at 3 locations → orchestrator makes 3 `POST /emails/campaigns/send` calls → 3 `campaign_sends` rows → 3 `email.campaign_completed` events → 3 `campaign.sent` publishes → campaign `completed`.

**Crash recovery — `campaign-orchestrate`:**
Insert campaign in `sending` with `audience_snapshot_id` already set + 2 of 3 `campaign_sends` rows present; fire worker → assert only missing location send submitted; no duplicate Audience Engine calls.

**Email Service spam gate:**
Email Service returns `422 spam_check_failed` for one location → that `campaign_sends` row set to `failed` → if all locations fail → campaign status = `failed`.

**`completed_with_errors`:**
2 locations succeed, 1 fails → campaign status = `completed_with_errors`; all 3 `campaign.sent` events still published for succeeded locations.

### Contract Tests

| Direction | Contract |
|---|---|
| Outbound | `POST /audiences/segments/:id/evaluate` payload shape matches Audience Engine spec |
| Outbound | `POST /audiences/evaluate` inline shape (`snapshot: true`) |
| Outbound | `GET /leads` query params + response shape matches Lead Service spec |
| Outbound | `POST /emails/campaigns/send` with `entity_type` + `entity_id` fields (Email Service spec amendment) |
| Outbound | `campaign.sent` EventBridge payload validated against `@ortho/types` schema |
| Inbound | `email.campaign_completed` payload: `job_id`, `status`, `sent_count`, `failed_count`, `total_recipients`, `location_id` |
| Inbound | `email.opened` payload: `campaign_job_id` (Email Service job UUID) + `entity_id` (campaign UUID) |
| Inbound | `lead.stage_changed` payload: `lead_id`, `stage_to`, `pipeline` |

---

## 10. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Send orchestration mechanism | BullMQ delayed jobs | Precise timing, crash-safe via Redis persistence, consistent with Email Service and Nurturing Engine patterns. Audience is resolved at send time (not schedule time) — no stale recipient lists. |
| A/B testing — default mode | Holdout (test/decide/send) | Maximises impact of winner: only a small test cohort receives the non-winning variant. Full-split mode available for campaigns where holdout is not desired. |
| A/B split configuration | Configurable `test_split_pct` (1–49) | Flexibility for campaigns of different sizes. Default `ab_winner_delay_hours = 4` matches PRD. |
| A/B open tracking | Atomic counters on `campaigns` row (`ab_opens_a`, `ab_opens_b`) | Simple and efficient. No separate table needed. Guards ensure opens are only counted during `ab_phase = 'testing'` window. |
| Holdout recipients storage | `campaign_recipients` with `sent_at = NULL` | Single table for all recipients. Conversion attribution guard (`sent_at IS NOT NULL`) naturally excludes unsent holdout leads. Simplifies ab-winner-select recovery. |
| Conversion attribution | Campaign Service subscribes to `lead.stage_changed`, 7-day window, `ON CONFLICT DO NOTHING` | Attribution is Campaign Service's concern — not a reporting-time join. First qualifying stage change per lead per campaign recorded. Holdout leads excluded until sent. |
| `campaign.sent` event timing | Published per location when `email.campaign_completed` received | Aligns with Analytics Service `CampaignSentHandler` which increments `metrics_campaigns_daily.sent`. One event per `(campaign_id, location_id)`. |
| Approval workflow | Comment-based review; approve and schedule are separate actions | Matches PRD: staff submit drafts, managers review with comments, approval and scheduling are distinct manager decisions. |
| Content lock after approval | All content fields locked at `approved` state | Prevents content changing after manager review. Manager rejects to `draft` if changes needed. `scheduled_for` remains editable without re-approval. |
| Multi-location orchestration | One Email Service job per `(location_id, variant/phase)` | Email Service requires `location_id` per job (per-location sending domain). `email_job_ref` uniqueness ensures idempotent re-submission on crash recovery. |
| Email Service spec amendment | Add `entity_type` + `entity_id` to `POST /emails/campaigns/send` | Required for `email.opened` / `email.clicked` EventBridge events to carry `campaign_id`, enabling Analytics `metrics_campaigns_daily` population and Campaign Service open tracking. |

---

## 11. Pending Amendments to Other Specs

| Spec | Amendment Required |
|---|---|
| Email Service spec | Add `entity_type` and `entity_id` fields to `POST /emails/campaigns/send` request body. These are passed through to all EventBridge events for that job (`email.opened`, `email.clicked`, `email.campaign_completed`). |
| Analytics spec | `campaign.sent` event payload confirmed: `{ campaign_id, location_id, sent_count, template_id, completed_at }`. `CampaignSentHandler` increments `metrics_campaigns_daily.sent` by `sent_count` for the `(date, campaign_id, location_id)` row. |
| Arch doc event table | Add `email.opened` and `email.clicked` subscribers: Campaign Service subscribes to `email.opened` (A/B open tracking). Add `lead.stage_changed` subscriber: Campaign Service (conversion attribution). |
