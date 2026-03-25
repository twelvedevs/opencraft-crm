# Referral Service — Design Spec

**Date:** 2026-03-25
**Status:** Draft
**Scope:** Product-layer Referral Service — referral link generation, click tracking, referral lifecycle, reward logging, doctor portal, leaderboard

---

## 1. Overview

The Referral Service is a **product-layer service** (`apps/crm/referral`) that owns all referral entities and logic in Ortho CRM. It manages two referral programs — patient referrals and referring doctor referrals — with full lifecycle tracking from link generation through reward fulfillment.

**Core responsibilities:**
- Manage referrers: patient referrers (auto-created when a patient completes treatment) and doctor referrers (staff-created with contact info)
- Generate unique referral link codes; serve a public click-tracking redirect endpoint
- Resolve codes to referrer identity (called by the embeddable form widget before lead submission)
- React to `lead.created` (with `referrer_id`) to create referral tracking records
- React to stage/conversion events to advance referral status, notify referring patients via SMS, and publish `referral.converted`
- Two-state reward tracking: `pending` auto-created on conversion → `issued` by staff
- Doctor portal via long-lived token URL (no login required)
- Leaderboard query endpoint for staff

**Out of scope:**
- Payment processing for rewards — CRM logs the reward event only
- Duplicate detection of referred leads — Lead Service handles dedup
- Sequence enrollment for post-treatment thank-you messages — Automation Engine's responsibility; it calls Referral Service to retrieve the link URL, then enrolls the entity in the sequence with the link in context
- Click-to-lead session stitching — referral attribution is captured at form submission via the hidden `referral_code` field resolved by the form widget

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
                    │  └─ event-worker.ts  (SQS / BullMQ)       │
                    │      handlers/                            │
                    │      ├─ lead-created.ts                   │
                    │      ├─ lead-stage-changed.ts             │
                    │      └─ lead-converted.ts                 │
                    └──────────────────────────────────────────┘
                         │            │              │
              calls      │            │ publishes    │ calls
           Lead Service  │     EventBridge           │ Messaging Service
           (patient info │     referral.converted    │ (SMS notifications)
            at creation) │                           │
                         ▼
                    crm_referrals schema
```

**Key architectural properties:**
- SQS worker pattern identical to Lead Service — EventBridge → SQS queue → BullMQ worker → typed handlers. Each handler runs atomically (state update in a single DB transaction).
- Public endpoints (link resolution, click redirect, doctor portal) are exposed without JWT via CRM API Gateway route configuration.
- Referral Service calls Lead Service (`GET /leads/:id`) once at patient referrer creation time using an internal service API key — stores `phone` and `name` denormalized on the `referrers` row for all future SMS sends.
- No Redis or BullMQ for scheduling — all processing is event-driven.

**Golden rule compliance:** Referral Service never reads across DB schemas. All Lead Service data access goes through the Lead Service REST API using an internal API key.

---

## 3. Referral Link Flow

The embeddable form widget (JavaScript, hosted by CRM, embedded on practice websites) handles referral attribution client-side:

1. Practice website receives `yourpractice.com/ref/:code` — this URL redirects through (or is proxied to) the CRM API Gateway's public redirect endpoint `GET /referrals/r/:code`
2. Referral Service records the click (`click_count` incremented), returns `302` to `redirect_url` with `?ref=:code` appended
3. Landing page loads with `?ref=:code` in the URL
4. Form widget reads `?ref=:code`, calls `GET /referrals/links/:code` → receives `{ referrer_id, referrer_type, referrer_name }`
5. Form widget embeds `referrer_id` and `referrer_type` as hidden fields
6. Form submits → Lead Service creates lead with `referrer_id` in immutable attribution
7. Lead Service publishes `lead.created` with `referrer_id` in payload
8. Referral Service SQS worker receives `lead.created`, creates `referrals` tracking record

If the code is invalid or inactive, `GET /referrals/links/:code` returns `404` — form widget submits without referral attribution; lead is still created normally.

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
redirect_url  varchar      NOT NULL           -- landing page URL (with ?ref=:code appended on redirect)
click_count   integer      NOT NULL DEFAULT 0
status        varchar      NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'inactive'))
created_by    uuid         NULL
created_at    timestamptz  NOT NULL DEFAULT now()
```

**Indexes:**
```sql
INDEX (referrer_id, status)
INDEX (code)                   -- public lookup on every form widget call
```

Code generation: 8-char random alphanumeric (`[A-Za-z0-9]`). `link.service.ts` retries up to 5 times on collision before returning `500`.

### `referrals`

One row per referred lead. Created by the `lead-created` SQS handler.

```sql
id                   uuid         PRIMARY KEY DEFAULT gen_random_uuid()
referral_link_id     uuid         NOT NULL REFERENCES referral_links(id)
referrer_id          uuid         NOT NULL REFERENCES referrers(id)
lead_id              uuid         NOT NULL UNIQUE  -- opaque ref, no FK across schemas
location_id          uuid         NOT NULL
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
reward_type    varchar      NULL      -- e.g. 'gift_card', 'account_credit'
reward_amount  numeric      NULL
reward_notes   text         NULL
issued_at      timestamptz  NULL
issued_by      uuid         NULL      -- staff user ID

UNIQUE (referral_id)                  -- one reward per conversion
INDEX (status, referrer_id)
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

UNIQUE (referrer_id)     -- one active token per referrer
INDEX (token)            -- public lookup on every portal load
```

---

## 5. API

All staff endpoints require a valid JWT via `@ortho/auth-middleware`. Location scoping enforced via `require-location.ts`.

### 5.1 Public Endpoints (no auth)

#### `GET /referrals/r/:code`

Click tracking redirect. Increments `click_count` on the matching `referral_links` row, then returns `302` to `redirect_url` with `?ref=:code` appended.

- `404` — code not found or `status = 'inactive'`
- Increment is best-effort (fire-and-forget update; redirect always proceeds)

#### `GET /referrals/links/:code`

Code resolution for the embeddable form widget. Called client-side before form submission.

**Response `200`:**
```json
{
  "referrer_id":   "uuid",
  "referrer_type": "patient",
  "referrer_name": "Jane Smith"
}
```

- `404` — code not found or `status = 'inactive'`

#### `GET /referrals/portal/:token`

Doctor portal. Returns referrer profile, all referrals, and aggregate stats.

**Response `200`:**
```json
{
  "referrer": {
    "id": "uuid",
    "name": "Dr. Smith",
    "practice_name": "Smile Dental",
    "location_id": "uuid"
  },
  "stats": {
    "total_referrals":    12,
    "exams_scheduled":    8,
    "cases_started":      5
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

- `404` — token not found
- Referral rows intentionally omit `lead_id` and lead PII — doctor sees counts and statuses only

---

### 5.2 Referrers

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/referrals/referrers` | Marketing Staff+ | Create doctor referrer. Body: `{ referrer_type: 'doctor', name, location_id, phone?, email?, practice_name?, address? }`. Automatically generates initial `referral_links` row. Returns `201` with referrer + link. `referrer_type` must be `'doctor'` — patient referrers are auto-created via event. |
| `GET` | `/referrals/referrers` | Any staff | Filter: `location_id`, `referrer_type`, `status`. Paginated cursor (default 50). |
| `GET` | `/referrals/referrers/:id` | Any staff | Full referrer record with active link + summary counts (`total_referrals`, `exams_scheduled`, `cases_started`). |
| `PATCH` | `/referrals/referrers/:id` | Marketing Staff+ | Update doctor contact info (`name`, `phone`, `email`, `practice_name`, `address`). `lead_id`, `referrer_type`, and `location_id` are immutable. Patient referrer `phone` and `name` are immutable via API (updated only via internal Lead Service call on creation). |
| `PATCH` | `/referrals/referrers/:id/status` | Marketing Manager+ | Body: `{ status: 'active' \| 'inactive' }`. Deactivating a referrer does not deactivate their links automatically — caller must deactivate links separately if desired. |

### 5.3 Referral Links

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/referrals/referrers/:id/links` | Marketing Staff+ | Generate new link. Body: `{ redirect_url }`. Deactivates any existing active link for this referrer. Returns new link with `code` and full URL. |
| `GET` | `/referrals/referrers/:id/links` | Any staff | List all links (active + inactive) with `click_count`. |
| `PATCH` | `/referrals/links/:id/status` | Marketing Staff+ | Body: `{ status: 'active' \| 'inactive' }`. At most one active link per referrer — activating a link deactivates any other active link for the same referrer. |

### 5.4 Referrals

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/referrals` | Any staff | List tracking records. Filter: `referrer_id`, `status`, `location_id`, `created_after`, `created_before`. Paginated cursor. |
| `GET` | `/referrals/:id` | Any staff | Full referral record including reward event (if exists). |
| `PATCH` | `/referrals/:id/notifications` | Any staff | Body: `{ notify_on_exam?: boolean, notify_on_conversion?: boolean }`. Per-referral notification preferences. |

### 5.5 Rewards

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/referrals/rewards` | Any staff | List reward events. Filter: `status` (`pending`\|`issued`), `location_id`, `referrer_id`. Paginated cursor. Primary use: staff work queue for pending rewards. |
| `PATCH` | `/referrals/rewards/:id` | Marketing Staff+ | Mark issued. Body: `{ status: 'issued', reward_type, reward_amount?, reward_notes? }`. Sets `issued_at = now()`, `issued_by = JWT sub`. Returns `400` if already issued. `reward_type` required when marking issued. |

### 5.6 Leaderboard

| Method | Path | Notes |
|---|---|---|
| `GET` | `/referrals/leaderboard` | Query params: `referrer_type` (`patient`\|`doctor`; default both), `location_id`, `period_start`, `period_end`, `limit` (default 20, max 100). Returns referrers ranked by `cases_started` DESC, with `exams_scheduled` and `total_referrals` as secondary columns. |

### 5.7 Doctor Portal Token

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/referrals/referrers/:id/portal-token` | Marketing Staff+ | Generate (or regenerate) portal token. Replaces any existing token (`UPSERT` on `referrer_id`). Returns `{ token, portal_url }`. Doctors only (`400` if referrer_type = 'patient'). |

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

**Subscribers:** Lead Service (activity timeline entry), Analytics Service (referral conversion metrics).

---

### 6.2 Events Subscribed (SQS Worker)

EventBridge routes all subscribed events to one SQS queue. BullMQ worker polls and dispatches to typed handlers. Each handler executes in a single DB transaction.

#### `lead.created` → `lead-created.ts`

**Condition:** `payload.referrer_id` is non-null.

**Handler behavior:**
1. Look up active `referral_links` row for `referrer_id` — if none found, log warn + skip (referrer may have been deactivated)
2. Insert `referrals` row: `{ referral_link_id, referrer_id, lead_id, location_id, status: 'created' }`
3. **Idempotency:** `ON CONFLICT (lead_id) DO NOTHING` — safe on SQS at-least-once redelivery

#### `lead.stage_changed` → `lead-stage-changed.ts`

**Condition:** `payload.stage_to = 'exam_scheduled'`

**Handler behavior:**
1. Look up `referrals` row by `lead_id` — if not found, skip (lead was not a referred lead)
2. Update: `status = 'exam_scheduled'`, `exam_scheduled_at = payload.transitioned_at`
3. If `referrals.notify_on_exam = true` AND `referrer.referrer_type = 'patient'`:
   - Call `POST /messages/send` (Messaging Service) with referrer's `phone`
   - Message body: configurable template stored in `notification.service.ts`; includes referrer name and location name from referrer record
4. **Idempotency:** status update is idempotent (same value on re-delivery)

#### `lead.converted` → `lead-converted.ts`

Two separate branches in the same handler based on `payload.to_pipeline`:

**Branch A — `to_pipeline = 'in_treatment'` (contract signed):**
1. Look up `referrals` row by `lead_id` — if not found, skip
2. Update: `status = 'converted'`, `converted_at = payload.converted_at`
3. Insert `reward_events` row: `{ referral_id, referrer_id, status: 'pending' }` — idempotency via `UNIQUE (referral_id)` + `ON CONFLICT DO NOTHING`
4. If `notify_on_conversion = true` AND `referrer_type = 'patient'`:
   - Call `POST /messages/send` with referrer's `phone`
5. Publish `referral.converted` to EventBridge (post-commit)

**Branch B — `to_pipeline = 'in_retention'` (treatment complete → patient referrer creation):**
1. Check if `referrers` row already exists for `lead_id` — if yes, skip (idempotent)
2. Call `GET /leads/:lead_id` (Lead Service, internal API key) → get `{ first_name, last_name, phone, location_id }`
3. Insert `referrers` row: `{ referrer_type: 'patient', lead_id, location_id, name: full_name, phone, created_by: null }`
4. Insert `referral_links` row with generated `code` and default `redirect_url` (configured via `DEFAULT_REFERRAL_REDIRECT_URL` env var)

If Lead Service call fails in Branch B: log error to Datadog + dead-letter the job. Staff can manually trigger referrer creation via `POST /referrals/referrers` as a fallback.

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
│   │   └── publisher.ts           # referral.converted
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
- AWS EventBridge (publish `referral.converted`)
- AWS SQS (subscribe to `lead.created`, `lead.stage_changed`, `lead.converted`)
- Messaging Service (REST — SMS notifications)
- Lead Service (REST — internal API key, patient info at referrer creation)
- No Redis · No additional BullMQ queues beyond SQS worker

---

## 8. Testing Strategy

### Unit Tests (Vitest)

- `link.service.ts` — code generation produces 8-char alphanumeric; collision retry logic (up to 5 attempts); unique constraint respected
- `notification.service.ts` — correct phone selected from referrer record; correct message body per notification type (`exam_scheduled`, `converted`); skips when `notify_on_exam = false` or `notify_on_conversion = false`; skips when `referrer_type = 'doctor'` (no SMS for doctors on these events)
- `reward.service.ts` — `400` on double-issue attempt; `issued_at` and `issued_by` set correctly

### Integration Tests (Vitest + real Postgres, Messaging Service + Lead Service mocked)

- `lead-created` handler — `referrals` row created when `referrer_id` present + active link exists; skip when `referrer_id` null; skip when no active link; idempotent on duplicate delivery (`ON CONFLICT DO NOTHING`)
- `lead-stage-changed` handler — status advances to `exam_scheduled`, `exam_scheduled_at` set; SMS called for patient referrer; no SMS called for doctor referrer; non-`exam_scheduled` stages skipped; missing referral record skipped
- `lead-converted` handler (Branch A) — status `converted`; `reward_events` row created with `pending`; `referral.converted` published; SMS sent; idempotent on duplicate delivery
- `lead-converted` handler (Branch B) — `referrers` + `referral_links` rows created; idempotent (second delivery skips); Lead Service call failure → dead-letters job
- `GET /referrals/r/:code` — `302` with correct redirect URL (`?ref=:code` appended); `click_count` incremented; `404` for inactive/unknown code
- `GET /referrals/links/:code` — `200` with `referrer_id`, `referrer_type`, `referrer_name`; `404` for inactive/unknown
- `GET /referrals/portal/:token` — `200` with referrer + referrals + correct stats; `404` for unknown token; referral rows omit `lead_id`
- `PATCH /referrals/rewards/:id` — `pending → issued` with `reward_type`, `issued_at`, `issued_by` set; `400` on double-issue; `reward_type` required
- `GET /referrals/leaderboard` — correct ranking by `cases_started` DESC; `referrer_type` filter works; `period_start`/`period_end` scoping correct
- `POST /referrals/referrers/:id/portal-token` — token generated; regeneration replaces previous token; `400` if patient referrer

### Contract Tests

- `referral.converted` payload contains all required fields: `referral_id`, `lead_id`, `referrer_id`, `referrer_type`, `location_id`, `converted_at`

---

## 9. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Referral attribution flow | Client-side resolution by form widget | Preserves Lead Service's zero-outbound-call pattern at creation time; attribution immutability unaffected; soft-fail on invalid code keeps lead creation robust |
| Patient referrer creation | Reactive on `lead.converted` to `in_retention` | Automatic, no staff action required; idempotent on SQS redelivery |
| Referrer phone storage | Denormalized on `referrers` row at creation | Avoids per-SMS lookup of Lead Service; acceptable stale risk for MVP |
| SMS notifications | Direct call to Messaging Service | Simpler than publishing an event and configuring an Automation Engine rule for referral-specific logic |
| Reward lifecycle | Two-state (`pending → issued`) | Gives staff an actionable work queue; no approval overhead for MVP |
| Doctor portal auth | Long-lived token in URL | No account management overhead; acceptable for a low-sensitivity, read-only view |
| Click tracking | Increment-on-redirect (best-effort) | Redirect never blocked by DB failure; analytics value doesn't justify blocking the user |
| Code generation | 8-char alphanumeric with collision retry | URL-safe, short enough for SMS links, collision probability negligible at expected volumes |

---

## 10. Pending Amendments Required

1. **Lead Service spec** — add `referrer_id` (uuid nullable) and `referrer_type` (varchar nullable) to `lead.created` event payload so Referral Service SQS worker can identify referred leads without a follow-up REST call
2. **Arch doc event table** — add `referral.converted` row: publisher = Referral Service, subscribers = Lead Service + Analytics Service
3. **Analytics Service spec** — add `referral.converted` handler to the SQS worker (new rollup table `metrics_referrals_daily` or routed through existing generic DSL — to be decided in Analytics spec amendment)
