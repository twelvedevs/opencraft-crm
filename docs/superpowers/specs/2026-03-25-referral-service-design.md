# Referral Service — Design Spec

**Date:** 2026-03-25
**Status:** Approved
**Scope:** Product-layer Referral Service — referral link generation, click tracking, referral lifecycle, reward logging, doctor portal, leaderboard

---

## 1. Overview

The Referral Service is a **product-layer service** (`apps/crm/referral`) that owns all referral entities and logic in Ortho CRM. It manages two referral programs — patient referrals and referring doctor referrals — with full lifecycle tracking from link generation through reward fulfillment.

**Core responsibilities:**
- Manage referrers: patient referrers (auto-created when a patient completes treatment) and doctor referrers (staff-created with contact info)
- Generate unique referral link codes; serve a public click-tracking redirect endpoint
- Resolve codes to referrer identity (called by the embeddable form widget before lead submission)
- React to `lead.created` (with `referrer_id` + `referral_code`) to create referral tracking records pinned to the specific clicked link
- React to stage/conversion events to advance referral status, notify referring patients via SMS, and publish `referral.converted`
- Publish `referrer.created` after patient referrer creation so Automation Engine can enroll the patient in the post-treatment sequence with the referral link URL in context
- Two-state reward tracking: `pending` auto-created on conversion → `issued` by staff
- Doctor portal via long-lived token URL (no login required)
- Leaderboard query endpoint for staff

**Out of scope:**
- Payment processing for rewards — CRM logs the reward event only
- Duplicate detection of referred leads — Lead Service handles dedup
- Sequence enrollment for post-treatment thank-you messages — Automation Engine's responsibility; it subscribes to `referrer.created` (published by Referral Service after patient referrer creation in Branch B) and enrolls the entity in the post-treatment sequence using `referral_link_url` from the event payload as context. This avoids a race condition where the Automation Engine fetches the link URL before Branch B has committed.
- Doctor thank-you notifications on conversion — out of scope for launch. Doctor relationship management is handled through manual outreach or future Campaign Service email campaigns.

---

## 2. Architecture

```
                    ┌──────────────────────────────────────────┐
                    │           Referral Service                │
                    │         apps/crm/referral                 │
                    │                                           │
  Public routes ──► │  routes/public/                           │
  (no auth)         │  ├─ links.ts      (resolve + redirect)    │
                    │  └─ portal.ts     (doctor portal)         │
                    │                                           │
  Staff routes ──► │  routes/                                   │
  (JWT)             │  ├─ referrers.ts                          │
                    │  ├─ referral-links.ts                     │
                    │  ├─ referrals.ts                          │
                    │  ├─ rewards.ts                            │
                    │  └─ leaderboard.ts                        │
                    │                                           │
                    │  services/                                │
                    │  ├─ referrer.service.ts                   │
                    │  ├─ link.service.ts                       │
                    │  ├─ referral.service.ts                   │
                    │  ├─ reward.service.ts                     │
                    │  └─ notification.service.ts               │
                    │                                           │
                    │  workers/                                 │
                    │  └─ event-worker.ts  (@ortho/event-bus)    │
                    │      handlers/                            │
                    │      ├─ lead-created.ts                   │
                    │      ├─ lead-stage-changed.ts             │
                    │      └─ lead-converted.ts                 │
                    └──────────────────────────────────────────┘
                         │            │               │
              calls      │            │ publishes     │ calls
           Lead Service  │     EventBridge            │ Messaging Service
           (patient info │     referral.converted     │ (SMS notifications)
            at creation) │     referrer.created       │
                         ▼
                    crm_referrals schema
```

**Key architectural properties:**
- Event worker pattern identical to Lead Service — `@ortho/event-bus` `.subscribe()` + `.start()` (EventBridgeDriver handles SQS polling internally). Each handler runs atomically (state update in a single DB transaction). No Redis, no BullMQ queue needed.
- Public endpoints (link resolution, click redirect, doctor portal) are exposed without JWT via CRM API Gateway route configuration. Rate limiting for public endpoints is enforced at the CRM API Gateway layer — Referral Service does not implement per-IP rate limiting itself.
- Referral Service calls Lead Service (`GET /leads/:id`) once at patient referrer creation time using an internal service API key — stores `phone` and `name` denormalized on the `referrers` row for all future SMS sends.
- No Redis or BullMQ for scheduling — all processing is event-driven.

**Golden rule compliance:** Referral Service never reads across DB schemas. All Lead Service data access goes through the Lead Service REST API using an internal API key.

---

## 3. Referral Link Flow

The embeddable form widget (JavaScript, hosted by CRM, embedded on practice websites) handles referral attribution client-side:

1. Practice website receives `yourpractice.com/ref/:code` — this URL redirects through (or is proxied to) the CRM API Gateway's public redirect endpoint `GET /referrals/r/:code`
2. Referral Service records the click (`click_count` incremented), returns `302` to `redirect_url` with `?ref=:code` appended. Unknown codes return `404`; inactive codes return `302` to `redirect_url` **without** `?ref=` (prospective patient still reaches the practice website, just without referral attribution)
3. Landing page loads with `?ref=:code` in the URL
4. Form widget reads `?ref=:code`, calls `GET /referrals/links/:code` → receives `{ referrer_id, referral_link_id, referrer_type, referrer_name }`. Returns `404` for unknown or inactive codes.
5. Form widget embeds `referrer_id`, `referral_link_id`, `referrer_type`, and `referral_code` as hidden fields
6. Form submits → Lead Service creates lead with `referrer_id`, `referrer_type`, and `referral_code` in immutable attribution
7. Lead Service publishes `lead.created` with `referrer_id`, `referrer_type`, and `referral_code` in payload
8. Referral Service SQS worker receives `lead.created`, resolves `referral_code` → specific `referral_link_id`, creates `referrals` tracking record pinned to that exact link

If the code is invalid or inactive at step 4, the form widget submits without referral attribution; the lead is still created normally.

**Dependency note:** Steps 6–8 depend on `referral_code`, `referrer_id`, and `referrer_type` being added to the Lead Service `leads` table and `lead.created` event payload (see Section 10, Pending Amendment 1). The `lead-created.ts` handler must not be shipped until this amendment is in place. A contract test (see Section 8) validates the incoming payload shape at deploy time.

---

## 4. Database Schema — `crm_referrals`

### `referrers`

One row per referring entity — either a patient (auto-created on treatment completion) or a doctor (staff-created).

```sql
id              uuid         PRIMARY KEY DEFAULT gen_random_uuid()
referrer_type   varchar      NOT NULL  CHECK (referrer_type IN ('patient', 'doctor'))
lead_id         uuid         NULL      -- patient referrers only; opaque ref, no FK across schemas
location_id     uuid         NOT NULL
name            varchar      NOT NULL  -- denormalized: patient from Lead Service; doctor staff-entered
phone           varchar      NULL      -- denormalized E.164; used for SMS notifications
email           varchar      NULL      -- doctor referrers only
practice_name   varchar      NULL      -- doctor referrers only
address         text         NULL      -- doctor referrers only
status          varchar      NOT NULL  DEFAULT 'active'
                             CHECK (status IN ('active', 'inactive'))
created_by      uuid         NULL      -- staff user ID; NULL for auto-created patient referrers
created_at      timestamptz  NOT NULL  DEFAULT now()
updated_at      timestamptz  NOT NULL  DEFAULT now()
```

**Indexes:**
```sql
UNIQUE (lead_id) WHERE referrer_type = 'patient'  -- one referrer record per patient lead
INDEX (location_id, referrer_type, status)
INDEX (lead_id)
```

### `referral_links`

One or more links per referrer; at most one active link at a time. Staff can deactivate and regenerate.

```sql
id            uuid         PRIMARY KEY DEFAULT gen_random_uuid()
referrer_id   uuid         NOT NULL REFERENCES referrers(id)
code          varchar      NOT NULL UNIQUE    -- 8-char alphanumeric, URL-safe
redirect_url  varchar      NOT NULL           -- landing page URL (redirect appends ?ref=:code when active)
click_count   integer      NOT NULL DEFAULT 0
status        varchar      NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'inactive'))
created_by    uuid         NULL
created_at    timestamptz  NOT NULL DEFAULT now()
```

**Indexes:**
```sql
INDEX (referrer_id, status)
-- Note: UNIQUE (code) constraint above implicitly creates a unique index in Postgres;
-- no separate INDEX (code) needed.
```

Code generation: 8-char random alphanumeric (`[A-Za-z0-9]`). `link.service.ts` retries up to 5 times on collision before returning `500`.

### `referrals`

One row per referred lead. Created by the `lead-created` SQS handler, pinned to the specific `referral_link_id` from the `lead.created` payload.

```sql
id                   uuid         PRIMARY KEY DEFAULT gen_random_uuid()
referral_link_id     uuid         NOT NULL REFERENCES referral_links(id)
referrer_id          uuid         NOT NULL REFERENCES referrers(id)
lead_id              uuid         NOT NULL UNIQUE  -- opaque ref, no FK across schemas
location_id          uuid         NOT NULL         -- from payload.location_id
status               varchar      NOT NULL DEFAULT 'created'
                     CHECK (status IN ('created', 'exam_scheduled', 'converted'))
exam_scheduled_at    timestamptz  NULL
converted_at         timestamptz  NULL
notify_on_exam       boolean      NOT NULL DEFAULT true
notify_on_conversion boolean      NOT NULL DEFAULT true
created_at           timestamptz  NOT NULL DEFAULT now()
updated_at           timestamptz  NOT NULL DEFAULT now()
```

**Indexes:**
```sql
UNIQUE (lead_id)                       -- idempotency: ON CONFLICT DO NOTHING in handler
INDEX (referrer_id, status)
INDEX (location_id, status)
```

### `reward_events`

Auto-created with `status = 'pending'` when a referral converts. Staff updates to `issued`.

```sql
id             uuid         PRIMARY KEY DEFAULT gen_random_uuid()
referral_id    uuid         NOT NULL REFERENCES referrals(id)
referrer_id    uuid         NOT NULL REFERENCES referrers(id)
status         varchar      NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'issued'))
reward_type    varchar      NULL      -- e.g. 'gift_card', 'account_credit'; required on issued transition
reward_amount  numeric      NULL
reward_notes   text         NULL
issued_at      timestamptz  NULL
issued_by      uuid         NULL      -- staff user ID
created_at     timestamptz  NOT NULL DEFAULT now()  -- when reward obligation was created (on conversion)

UNIQUE (referral_id)                  -- one reward per conversion
INDEX (status, created_at)            -- work queue: pending rewards sorted by age
INDEX (referrer_id)
```

### `portal_tokens`

Long-lived token URL for doctor portal access. One active token per doctor referrer (regeneration replaces previous).

```sql
id           uuid         PRIMARY KEY DEFAULT gen_random_uuid()
referrer_id  uuid         NOT NULL REFERENCES referrers(id)
token        uuid         NOT NULL UNIQUE DEFAULT gen_random_uuid()
created_by   uuid         NOT NULL
created_at   timestamptz  NOT NULL DEFAULT now()

UNIQUE (referrer_id)     -- one active token per referrer; UPSERT replaces on regeneration
INDEX (token)            -- public lookup on every portal load
-- Note: patient referrer guard (400 if referrer_type = 'patient') is enforced at the
-- service layer in POST /referrals/referrers/:id/portal-token. No DB-level constraint
-- possible without a trigger; implementation must not omit this check.
```

---

## 5. API

All staff endpoints require a valid JWT via `@ortho/auth-middleware`. Location scoping enforced via `require-location.ts` — agents see only their assigned location(s) (`locations[]` from JWT claims; empty array = all locations for marketing/super_admin roles).

### 5.1 Public Endpoints (no auth)

#### `GET /referrals/r/:code`

Click tracking redirect. Increments `click_count` on the matching `referral_links` row, then redirects.

- Active code → `302` to `redirect_url` with `?ref=:code` appended. Increment is best-effort (fire-and-forget update; redirect always proceeds).
- Inactive code → `302` to `redirect_url` **without** `?ref=` (prospective patient still reaches the practice website; no referral attribution captured).
- Unknown code → `404`

#### `GET /referrals/links/:code`

Code resolution for the embeddable form widget. Called client-side before form submission.

**Response `200`:**
```json
{
  "referrer_id":      "uuid",
  "referral_link_id": "uuid",
  "referrer_type":    "patient",
  "referrer_name":    "Jane Smith"
}
```

- `404` — code not found **or** `status = 'inactive'` (form widget treats both as no referral attribution)

#### `GET /referrals/portal/:token`

Doctor portal. Returns referrer profile, all referrals, and aggregate stats.

**Response `200`:**
```json
{
  "referrer": {
    "id":            "uuid",
    "name":          "Dr. Smith",
    "practice_name": "Smile Dental",
    "location_id":   "uuid"
  },
  "stats": {
    "total_referrals": 12,
    "exams_scheduled": 8,
    "cases_started":   5
  },
  "referrals": [
    {
      "id":                "uuid",
      "status":            "converted",
      "exam_scheduled_at": "...",
      "converted_at":      "..."
    }
  ]
}
```

Stats are computed from the `referrals` table:
- `total_referrals` = COUNT of `referrals` rows for this referrer
- `exams_scheduled` = COUNT WHERE `status IN ('exam_scheduled', 'converted')`
- `cases_started` = COUNT WHERE `status = 'converted'`

All three counts are unscoped by date (lifetime totals) on the portal. The portal `referrals[]` array omits `lead_id` and lead PII — doctor sees statuses and timestamps only.

- `404` — token not found

---

### 5.2 Referrers

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/referrals/referrers` | Marketing Staff+ | Create doctor referrer. Body: `{ referrer_type: 'doctor', name, location_id, phone?, email?, practice_name?, address? }`. `referrer_type` must be `'doctor'` — patient referrers are auto-created via event. Automatically generates initial `referral_links` row with `redirect_url` from `DEFAULT_REFERRAL_LANDING_URL` env var. Returns `201` with referrer + link. |
| `GET` | `/referrals/referrers` | Any staff | Filter: `location_id`, `referrer_type`, `status`. Paginated cursor (default 50). Location scoped — agents see own location only. |
| `GET` | `/referrals/referrers/:id` | Any staff | Full referrer record with active link + summary counts (`total_referrals`, `exams_scheduled`, `cases_started`). |
| `PATCH` | `/referrals/referrers/:id` | Marketing Staff+ | Update doctor contact info (`name`, `phone`, `email`, `practice_name`, `address`). `lead_id`, `referrer_type`, and `location_id` are immutable. Patient referrer `phone` and `name` are immutable via API — updated only via Lead Service call at auto-creation. |
| `PATCH` | `/referrals/referrers/:id/status` | Marketing Manager+ | Body: `{ status: 'active' \| 'inactive' }`. Deactivating a referrer does not deactivate their links automatically — caller must deactivate links separately if desired. |

### 5.3 Referral Links

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/referrals/referrers/:id/links` | Marketing Staff+ | Generate new link. Body: `{ redirect_url }`. Deactivates any existing active link for this referrer. Returns new link with `code` and full redirect URL. |
| `GET` | `/referrals/referrers/:id/links` | Any staff | List all links (active + inactive) with `click_count`. |
| `PATCH` | `/referrals/links/:id/status` | Marketing Staff+ | Body: `{ status: 'active' \| 'inactive' }`. Activating a link deactivates any other active link for the same referrer (at most one active per referrer). |

### 5.4 Referrals

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/referrals` | Any staff | List tracking records. Filter: `referrer_id`, `status`, `location_id`, `created_after`, `created_before`. Paginated cursor. Location scoped — agents see own location only. |
| `GET` | `/referrals/:id` | Any staff | Full referral record including reward event if exists. |
| `PATCH` | `/referrals/:id/notifications` | Any staff | Body: `{ notify_on_exam?: boolean, notify_on_conversion?: boolean }`. Per-referral notification preferences. |

### 5.5 Rewards

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/referrals/rewards` | Any staff | List reward events. Filter: `status` (`pending`\|`issued`), `location_id`, `referrer_id`. Default sort: `created_at ASC` (oldest pending first). Paginated cursor. Location scoped — agents see own location only. |
| `PATCH` | `/referrals/rewards/:id` | Marketing Staff+ | Mark issued. Body: `{ status: 'issued', reward_type, reward_amount?, reward_notes? }`. `reward_type` is required. Sets `issued_at = now()`, `issued_by = JWT sub`. Returns `400` if already issued. |

### 5.6 Leaderboard

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/referrals/leaderboard` | Any staff | Query params: `referrer_type` (`patient`\|`doctor`; default both), `location_id`, `period_start`, `period_end`, `limit` (default 20, max 100). Returns referrers ranked by `cases_started` DESC (within period), with `exams_scheduled` and `total_referrals` as secondary columns. Location scoped — agents see own location only. Period scoping uses `referrals.converted_at` for `cases_started`, `referrals.exam_scheduled_at` for `exams_scheduled`, and `referrals.created_at` for `total_referrals`. |

### 5.7 Doctor Portal Token

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/referrals/referrers/:id/portal-token` | Marketing Staff+ | Generate (or regenerate) portal token for a doctor referrer. `400` if `referrer_type = 'patient'`. Replaces any existing token (`UPSERT` on `referrer_id`). Returns `{ token, portal_url }`. |

---

**Error shape** (consistent with other services): `{ "error": "<message>" }`

---

## 6. Events

### 6.1 Events Published

#### `referral.converted`

Published when a referred lead signs a contract (triggered by `lead.converted` to `in_treatment`).

```json
{
  "event_id":    "uuid",
  "event_type":  "referral.converted",
  "entity_type": "referral",
  "entity_id":   "<referral_id>",
  "payload": {
    "referral_id":   "uuid",
    "lead_id":       "uuid",
    "referrer_id":   "uuid",
    "referrer_type": "patient",
    "location_id":   "uuid",
    "converted_at":  "..."
  }
}
```

**Subscribers:** Lead Service (activity timeline entry), Analytics Service (referral conversion metrics). Automation Engine is intentionally excluded from subscribers for launch — no referral-triggered automation workflows are in scope.

---

#### `referrer.created`

Published after Branch B of `lead-converted.ts` commits (patient referrer + link created on treatment completion). Automation Engine subscribes to this event to enroll the patient in the post-treatment retention sequence with the referral link URL in context, avoiding a race condition where the Automation Engine might otherwise fetch the link before it exists.

```json
{
  "event_id":    "uuid",
  "event_type":  "referrer.created",
  "entity_type": "referrer",
  "entity_id":   "<referrer_id>",
  "payload": {
    "referrer_id":        "uuid",
    "referrer_type":      "patient",
    "lead_id":            "uuid",
    "location_id":        "uuid",
    "referral_link_id":   "uuid",
    "referral_code":      "abc123XY",
    "referral_link_url":  "https://api.yourpractice.com/referrals/r/abc123XY",
    "created_at":         "..."
  }
}
```

**Subscribers:** Automation Engine (trigger post-treatment sequence enrollment with `referral_link_url` in context).

---

### 6.2 Events Subscribed (SQS Worker)

EventBridge routes all subscribed events to one SQS queue. BullMQ worker polls and dispatches to typed handlers. Each handler executes in a single DB transaction.

#### `lead.created` → `lead-created.ts`

**Precondition:** This handler requires `referral_code`, `referrer_id`, and `referrer_type` to be present in the `lead.created` payload. **This handler must not be shipped until Pending Amendment 1 (Lead Service spec) is implemented.** A contract test (Section 8) validates the payload shape at deploy time and will fail if the fields are absent.

**Condition:** `payload.referrer_id` is non-null AND `payload.referral_code` is non-null.

**Handler behavior:**
1. Look up `referral_links` row by `payload.referral_code` — if found (active or inactive), use that `referral_link_id`. If code not found in DB (true data-integrity edge case — code was never created or was hard-deleted, which is not a normal operational state), log warn + skip. **Do not fall back to the active link** — mis-attributing a referral to a link the lead never clicked is worse than not recording the referral. The inactive-link case is handled upstream: `GET /referrals/links/:code` returns `404` for inactive codes, so the form widget never embeds referral fields for inactive links; `referral_code` will be absent from the `lead.created` payload in that case.
2. Insert `referrals` row: `{ referral_link_id, referrer_id: payload.referrer_id, lead_id: payload.lead_id, location_id: payload.location_id, status: 'created' }`
3. **Idempotency:** `ON CONFLICT (lead_id) DO NOTHING` — safe on SQS at-least-once redelivery

#### `lead.stage_changed` → `lead-stage-changed.ts`

**Condition:** `payload.pipeline = 'new_patient'` AND `payload.stage_to = 'exam_scheduled'`

The pipeline guard is required — do not fire on stages named `exam_scheduled` in other pipelines (defensive against future changes to the state machine).

**Handler behavior:**
1. Look up `referrals` row by `payload.lead_id` — if not found, skip (lead was not a referred lead)
2. Update: `status = 'exam_scheduled'`, `exam_scheduled_at = payload.transitioned_at`
3. If `referrals.notify_on_exam = true` AND `referrer.referrer_type = 'patient'` AND referrer `phone` is non-null:
   - Call `POST /messages/send` (Messaging Service) with referrer's `phone` and `dedup_key = "referral_exam_notify:{referral_id}"` to prevent duplicate SMS on SQS redelivery
   - Message body: built by `notification.service.ts`; includes referrer first name
4. **Idempotency:** DB status update is idempotent on redelivery; `dedup_key` on Messaging Service call prevents duplicate SMS

#### `lead.converted` → `lead-converted.ts`

Two separate branches in the same handler based on `payload.to_pipeline`:

**Branch A — `to_pipeline = 'in_treatment'` (contract signed):**
1. Look up `referrals` row by `payload.lead_id` — if not found, skip
2. Update: `status = 'converted'`, `converted_at = payload.converted_at`
3. Insert `reward_events` row: `{ referral_id, referrer_id, status: 'pending' }` — idempotency via `UNIQUE (referral_id)` + `ON CONFLICT DO NOTHING`
4. If `notify_on_conversion = true` AND `referrer_type = 'patient'` AND referrer `phone` is non-null:
   - Call `POST /messages/send` with referrer's `phone` and `dedup_key = "referral_conversion_notify:{referral_id}"` to prevent duplicate SMS on SQS redelivery
5. Publish `referral.converted` to EventBridge (post-commit)

**Branch B — `to_pipeline = 'in_retention'` (treatment complete → patient referrer creation):**
1. Check if `referrers` row already exists for `lead_id` — if yes, skip (idempotent on SQS redelivery)
2. Call `GET /leads/:lead_id` (Lead Service, internal API key) → get `{ first_name, last_name, phone, location_id }`
3. Insert `referrers` row: `{ referrer_type: 'patient', lead_id, location_id, name: first_name + ' ' + last_name, phone, created_by: null }`
4. Insert `referral_links` row with generated `code` and `redirect_url` from `DEFAULT_REFERRAL_LANDING_URL` env var (the practice landing page URL — distinct from `REFERRAL_BASE_URL` which is the API gateway base used in the redirect endpoint URL)
5. Publish `referrer.created` to EventBridge (post-commit) with `referral_link_url` constructed as `REFERRAL_BASE_URL` + `/referrals/r/` + `code` — where `REFERRAL_BASE_URL` is the CRM API Gateway's public base URL (e.g. `https://api.yourpractice.com`). This URL routes through the click-tracking redirect endpoint so all clicks originating from the post-treatment sequence are counted in `click_count`. Do **not** use the landing page URL with `?ref=` baked in — that would bypass click tracking.

If Lead Service call fails in Branch B: log error to Datadog + dead-letter the job. Staff can manually create the referrer via `POST /referrals/referrers` as a fallback — after manual creation the Automation Engine won't receive `referrer.created`, so sequence enrollment must be triggered manually as well.

---

## 7. Service Layout

```
apps/crm/referral/
├── src/
│   ├── routes/
│   │   ├── public/
│   │   │   ├── links.ts           # GET /referrals/r/:code, GET /referrals/links/:code
│   │   │   └── portal.ts          # GET /referrals/portal/:token
│   │   ├── referrers.ts
│   │   ├── referral-links.ts
│   │   ├── referrals.ts
│   │   ├── rewards.ts
│   │   └── leaderboard.ts
│   ├── services/
│   │   ├── referrer.service.ts    # CRUD + patient referrer creation from event
│   │   ├── link.service.ts        # code generation, click tracking, resolution
│   │   ├── referral.service.ts    # tracking record lifecycle
│   │   ├── reward.service.ts      # pending → issued transitions
│   │   └── notification.service.ts # builds message body, calls Messaging Service
│   ├── repositories/
│   │   ├── referrer.repo.ts
│   │   ├── referral-link.repo.ts
│   │   ├── referral.repo.ts
│   │   ├── reward.repo.ts
│   │   └── portal-token.repo.ts
│   ├── workers/
│   │   ├── event-worker.ts        # BullMQ worker, SQS polling
│   │   └── handlers/
│   │       ├── lead-created.ts
│   │       ├── lead-stage-changed.ts
│   │       └── lead-converted.ts
│   ├── events/
│   │   └── publisher.ts           # referral.converted + referrer.created
│   ├── clients/
│   │   └── lead-service.client.ts # GET /leads/:id with internal API key
│   └── index.ts
├── migrations/
├── test/
├── Dockerfile
├── package.json
└── tsconfig.json
```

**Runtime dependencies:**
- PostgreSQL (shared RDS cluster, `crm_referrals` schema)
- AWS EventBridge (publish `referral.converted`, `referrer.created`)
- AWS SQS (subscribe to `lead.created`, `lead.stage_changed`, `lead.converted`)
- Messaging Service (REST — SMS notifications)
- Lead Service (REST — internal API key, patient info at referrer creation)
- No Redis · No additional BullMQ queues beyond SQS worker

---

## 8. Testing Strategy

### Unit Tests (Vitest)

- `link.service.ts` — code generation produces 8-char alphanumeric; collision retry logic (up to 5 attempts); returns `500` on 5 consecutive collisions
- `notification.service.ts` — correct phone selected from referrer record; correct message body per notification type (`exam_scheduled`, `converted`); skips when `notify_on_exam = false` or `notify_on_conversion = false`; skips when `referrer_type = 'doctor'`; skips when `phone` is null
- `reward.service.ts` — `400` on double-issue attempt; `issued_at` and `issued_by` set correctly; `reward_type` required on issue

### Integration Tests (Vitest + real Postgres, Messaging Service + Lead Service mocked)

- `lead-created` handler — `referrals` row created pinned to the specific link matching `referral_code`; code not in DB → log warn + skip, no referral row created; skip when `referrer_id` null; skip when no active/matching link found; idempotent on duplicate delivery
- `lead-stage-changed` handler — status advances to `exam_scheduled`, `exam_scheduled_at` set; SMS sent with correct `dedup_key` for patient referrer; no SMS for doctor referrer; non-`exam_scheduled` stage skipped; `pipeline != 'new_patient'` skipped; missing referral record skipped; Messaging Service `dedup_key` prevents duplicate SMS on second delivery of same event
- `lead-converted` handler (Branch A) — status `converted`; `reward_events` row created with `pending`; `referral.converted` published; SMS sent with `dedup_key`; idempotent on duplicate delivery
- `lead-converted` handler (Branch B) — `referrers` + `referral_links` rows created; `referrer.created` published with `referral_link_url`; idempotent (second delivery skips); Lead Service call failure → dead-letters job
- `GET /referrals/r/:code` — active code: `302` with `?ref=:code` appended + `click_count` incremented; inactive code: `302` without `?ref=` + no increment; unknown code: `404`
- `GET /referrals/links/:code` — `200` with `referrer_id`, `referral_link_id`, `referrer_type`, `referrer_name`; `404` for inactive; `404` for unknown
- `GET /referrals/portal/:token` — `200` with referrer + referrals + correct stats (`total_referrals`, `exams_scheduled`, `cases_started` computed correctly); `404` for unknown token; referral rows omit `lead_id`
- `PATCH /referrals/rewards/:id` — `pending → issued` with `reward_type`, `issued_at`, `issued_by` set; `400` on double-issue; `400` when `reward_type` absent
- `GET /referrals/leaderboard` — correct ranking by `cases_started` DESC; `referrer_type` filter applied; `period_start`/`period_end` scoping uses correct date columns per metric; location scoping for agents
- `POST /referrals/referrers/:id/portal-token` — token generated; regeneration replaces previous token (UPSERT); `400` if `referrer_type = 'patient'`

### Contract Tests

- Incoming `lead.created` payload shape: assert `referrer_id`, `referrer_type`, and `referral_code` fields exist (nullable). **This test must fail if the Lead Service amendment has not been deployed** — blocks `lead-created.ts` handler from shipping prematurely.
- Outgoing `referral.converted` payload: all required fields present (`referral_id`, `lead_id`, `referrer_id`, `referrer_type`, `location_id`, `converted_at`)
- Outgoing `referrer.created` payload: all required fields present (`referrer_id`, `lead_id`, `location_id`, `referral_link_id`, `referral_code`, `referral_link_url`); assert `referral_link_url` matches pattern `*/referrals/r/<code>` (contains redirect endpoint path, not a landing page URL with `?ref=` baked in)

---

## 9. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Referral attribution flow | Client-side resolution by form widget | Preserves Lead Service's zero-outbound-call pattern at creation time; attribution immutability unaffected; soft-fail on invalid code keeps lead creation robust |
| Specific link pinning | `referral_code` passed through form widget → Lead Service → `lead.created` payload | Ensures `referrals.referral_link_id` is accurate; prevents mis-attribution when a referrer's link is deactivated between click and form submission |
| Sequence enrollment timing | Automation Engine subscribes to `referrer.created` (not `lead.converted`) | Eliminates race condition where Automation Engine fetches referral link before Branch B has committed |
| Patient referrer creation | Reactive on `lead.converted` to `in_retention` | Automatic, no staff action required; idempotent on SQS redelivery |
| Referrer phone storage | Denormalized on `referrers` row at creation | Avoids per-SMS lookup of Lead Service; acceptable stale risk for MVP (patient phones rarely change post-treatment) |
| SMS notifications | Direct call to Messaging Service with `dedup_key` | Simpler than event-based approach; `dedup_key` ensures idempotency on SQS redelivery |
| Doctor thank-you | Deferred for launch | Doctor relationship is managed through manual outreach; SMS requires phone which is optional for doctors; future Campaign Service email campaigns can cover this |
| Reward lifecycle | Two-state (`pending → issued`) | Gives staff an actionable work queue; no approval overhead for MVP |
| Doctor portal auth | Long-lived token in URL | No account management overhead; acceptable for a low-sensitivity, read-only view |
| Click tracking | `302` for inactive codes (no `?ref=`) rather than `404` | Prospective patient still reaches the practice website; `404` looks broken when shared in SMS/email |
| Code generation | 8-char alphanumeric with collision retry | URL-safe, short enough for SMS links, collision probability negligible at expected volumes |

---

## 10. Pending Amendments Required

1. ~~**Lead Service spec** — add `referrer_id`, `referrer_type`, and `referral_code` to the `leads` table DDL and `lead.created` event payload.~~ **Status: already implemented.** The Lead Service spec (§3.1 DDL and §5.1 event payload) already includes all three fields as optional nullable columns and payload fields. No changes required to the Lead Service spec.

2. **Arch doc event table** — add:
   - `referral.converted`: publisher = Referral Service, subscribers = Lead Service + Analytics Service
   - `referrer.created`: publisher = Referral Service, subscribers = Automation Engine

3. **Analytics Service spec** — add `referral.converted` handler to the SQS worker (new rollup table `metrics_referrals_daily` or routed through existing generic DSL — to be decided in Analytics spec amendment)

4. **Automation Engine spec** — add `referrer.created` to the supported event trigger catalog with `entity_type = 'referrer'` and `event_type = 'referrer.created'`. Document that event payload fields (e.g. `referral_link_url`, `lead_id`, `location_id`) are available as context variables in downstream action steps. Specifically, the post-treatment workflow rule subscribes to `referrer.created`, reads `referral_link_url` from the event payload, and passes it as a context field when calling `POST /sequences/enroll` — so the Nurturing Engine can include the referral link URL in the post-treatment thank-you SMS template.

5. **Pipeline Engine spec** — confirm that the `lead.converted` event payload includes `to_pipeline` field (values: `'in_treatment'` | `'in_retention'`). The Referral Service `lead-converted.ts` handler branches on this field. Per the existing Pipeline Engine spec Section 6, the `lead.converted` payload includes `to_pipeline` as `"to_pipeline": "in_treatment"` — this amendment is a cross-reference confirmation, not a new field addition.
