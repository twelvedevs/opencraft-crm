# Referral Service — Updated Design Spec

**Date:** 2026-04-08
**Status:** Approved
**Scope:** Product-layer Referral Service — referral link generation, click tracking, referral lifecycle, reward logging, doctor portal, leaderboard
**Supersedes:** `2026-03-25-referral-service-design.md`
**Changes:** Incorporates all clarifying Q&A answers from `tasks/prd-questions-referral-service.md`

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
- Sequence enrollment for post-treatment thank-you messages — Automation Engine's responsibility; it subscribes to `referrer.created` and enrolls the entity in the post-treatment sequence using `referral_link_url` from the event payload as context
- Doctor thank-you notifications on conversion — out of scope for launch

---

## 2. Architecture

```
                    ┌──────────────────────────────────────────┐
                    │           Referral Service                │
                    │         apps/crm/referral                 │
                    │                                           │
  Public routes ──► │  routes/public/   (encapsulated scope,    │
  (no auth)         │  no authPlugin registered)                │
                    │  ├─ links.ts      (resolve + redirect)    │
                    │  └─ portal.ts     (doctor portal)         │
                    │                                           │
  Staff routes ──► │  routes/          (authPlugin scope)       │
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
                    │  worker.ts  (separate ECS task)           │
                    │  @ortho/event-bus .subscribe() + .start() │
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

- **Event worker:** Uses `@ortho/event-bus` `.subscribe()` + `.start()` (EventBridgeDriver handles SQS polling internally). Identical pattern to Lead Service and Campaign Service. **No Redis, no BullMQ queue needed.** The worker runs as a **separate ECS task** from the HTTP server (separate entry points: `index.ts` and `worker.ts`), allowing independent scaling.
- **Public route auth bypass:** Public endpoints (link resolution, click redirect, doctor portal) are registered in a separate Fastify **encapsulated scope** that does not have `authPlugin` registered. Scoped routes outside the encapsulated scope use `authPlugin` normally. Rate limiting for public endpoints is enforced at the CRM API Gateway layer.
- **RBAC:** `@ortho/auth-middleware` `ROLE_PERMISSIONS` is updated as part of this implementation to add `referrals:read` (all staff roles) and `referrals:write` (Marketing Staff, Marketing Manager, super_admin). Routes use `requirePermission('referrals:read')` / `requirePermission('referrals:write')`.
- **Lead Service call:** Referral Service calls Lead Service (`GET /leads/:id`) once at patient referrer creation time using `LEAD_SERVICE_API_KEY` — stores `phone` and `name` denormalized on the `referrers` row for all future SMS sends.

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

**Lead Service amendment status:** `@ortho/types` `LeadCreatedPayload` already includes `referrer_id?`, `referrer_type?`, and `referral_code?` as optional fields, and the Lead Service publisher already emits them. The `lead-created.ts` handler ships from day one; no blocking condition.

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

All staff endpoints require a valid JWT via `@ortho/auth-middleware`. Routes use `requirePermission('referrals:read')` for read endpoints and `requirePermission('referrals:write')` for write/manage endpoints. **`@ortho/auth-middleware` `ROLE_PERMISSIONS` must be updated as part of this implementation** to include:
- `referrals:read` — all five roles (call_center_agent, call_center_manager, marketing_staff, marketing_manager, super_admin)
- `referrals:write` — marketing_staff, marketing_manager, super_admin

Location scoping enforced via `require-location.ts` — agents see only their assigned location(s) (`locations[]` from JWT claims; empty array = all locations for marketing/super_admin roles).

### 5.1 Public Endpoints (no auth)

Registered in a separate Fastify **encapsulated scope** (`fastify.register(async (app) => { ... })`) that does **not** have `authPlugin` registered. The encapsulation boundary ensures JWT enforcement from the parent scope does not apply.

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

| Method | Path | Permission | Notes |
|---|---|---|---|
| `POST` | `/referrals/referrers` | `referrals:write` | Create doctor referrer. Body: `{ referrer_type: 'doctor', name, location_id, phone?, email?, practice_name?, address? }`. `referrer_type` must be `'doctor'` — patient referrers are auto-created via event. Automatically generates initial `referral_links` row with `redirect_url` from `DEFAULT_REFERRAL_LANDING_URL` env var. Returns `201` with referrer + link. |
| `GET` | `/referrals/referrers` | `referrals:read` | Filter: `location_id`, `referrer_type`, `status`. Paginated cursor (default 50). Location scoped — agents see own location only. |
| `GET` | `/referrals/referrers/:id` | `referrals:read` | Full referrer record with active link + summary counts (`total_referrals`, `exams_scheduled`, `cases_started`). |
| `PATCH` | `/referrals/referrers/:id` | `referrals:write` | Update doctor contact info (`name`, `phone`, `email`, `practice_name`, `address`). `lead_id`, `referrer_type`, and `location_id` are immutable. Patient referrer `phone` and `name` are immutable via API — updated only via Lead Service call at auto-creation. |
| `PATCH` | `/referrals/referrers/:id/status` | `referrals:write` (Marketing Manager+) | Body: `{ status: 'active' \| 'inactive' }`. Deactivating a referrer does not deactivate their links automatically — caller must deactivate links separately if desired. |

### 5.3 Referral Links

| Method | Path | Permission | Notes |
|---|---|---|---|
| `POST` | `/referrals/referrers/:id/links` | `referrals:write` | Generate new link. Body: `{ redirect_url }`. Deactivates any existing active link for this referrer. Returns new link with `code` and full redirect URL. |
| `GET` | `/referrals/referrers/:id/links` | `referrals:read` | List all links (active + inactive) with `click_count`. |
| `PATCH` | `/referrals/links/:id/status` | `referrals:write` | Body: `{ status: 'active' \| 'inactive' }`. Activating a link deactivates any other active link for the same referrer (at most one active per referrer). |

### 5.4 Referrals

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/referrals` | `referrals:read` | List tracking records. Filter: `referrer_id`, `status`, `location_id`, `created_after`, `created_before`. Paginated cursor. Location scoped — agents see own location only. |
| `GET` | `/referrals/:id` | `referrals:read` | Full referral record including reward event if exists. |
| `PATCH` | `/referrals/:id/notifications` | `referrals:read` | Body: `{ notify_on_exam?: boolean, notify_on_conversion?: boolean }`. Per-referral notification preferences. |

### 5.5 Rewards

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/referrals/rewards` | `referrals:read` | List reward events. Filter: `status` (`pending`\|`issued`), `location_id`, `referrer_id`. Default sort: `created_at ASC` (oldest pending first). Paginated cursor. Location scoped — agents see own location only. |
| `PATCH` | `/referrals/rewards/:id` | `referrals:write` | Mark issued. Body: `{ status: 'issued', reward_type, reward_amount?, reward_notes? }`. `reward_type` is required. Sets `issued_at = now()`, `issued_by = JWT sub`. Returns `400` if already issued. |

### 5.6 Leaderboard

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/referrals/leaderboard` | `referrals:read` | Query params: `referrer_type` (`patient`\|`doctor`; default both), `location_id`, `period_start`, `period_end`, `limit` (default 20, max 100). Returns referrers ranked by `cases_started` DESC (within period), with `exams_scheduled` and `total_referrals` as secondary columns. Location scoped — agents see own location only. Period scoping uses `referrals.converted_at` for `cases_started`, `referrals.exam_scheduled_at` for `exams_scheduled`, and `referrals.created_at` for `total_referrals`. |

### 5.7 Doctor Portal Token

| Method | Path | Permission | Notes |
|---|---|---|---|
| `POST` | `/referrals/referrers/:id/portal-token` | `referrals:write` | Generate (or regenerate) portal token for a doctor referrer. `400` if `referrer_type = 'patient'`. Replaces any existing token (`UPSERT` on `referrer_id`). Returns `{ token, portal_url }`. |

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

**Subscribers:** Lead Service (activity timeline entry), Analytics Service (referral conversion metrics). Automation Engine is intentionally excluded from subscribers for launch.

---

#### `referrer.created`

Published after Branch B of `lead-converted.ts` commits (patient referrer + link created on treatment completion).

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

### 6.2 Events Subscribed (`@ortho/event-bus` Worker)

EventBridge routes all subscribed events to one SQS queue. `@ortho/event-bus` `.subscribe()` + `.start()` handles SQS polling internally (EventBridgeDriver). Each handler runs atomically in a single DB transaction. **No Redis. No BullMQ queue.**

The event worker runs as a **separate process** (`worker.ts`) deployed as an independent ECS task from the HTTP server.

#### `lead.created` → `lead-created.ts`

The Lead Service already emits `referrer_id?`, `referrer_type?`, and `referral_code?` in the `lead.created` payload. This handler ships from day one.

**Condition:** `payload.referrer_id` is non-null AND `payload.referral_code` is non-null.

**Handler behavior:**
1. Look up `referral_links` row by `payload.referral_code` — if found (active or inactive), use that `referral_link_id`. If code not found in DB, **log warn + skip** (do not fall back to the active link — mis-attributing a referral to a link the lead never clicked is worse than not recording the referral). The inactive-link case is handled upstream: `GET /referrals/links/:code` returns `404` for inactive codes, so the form widget never embeds referral fields for inactive links.
2. Insert `referrals` row: `{ referral_link_id, referrer_id: payload.referrer_id, lead_id: payload.lead_id, location_id: payload.location_id, status: 'created' }`
3. **Idempotency:** `ON CONFLICT (lead_id) DO NOTHING` — safe on SQS at-least-once redelivery

#### `lead.stage_changed` → `lead-stage-changed.ts`

**Condition:** `payload.pipeline = 'new_patient'` AND `payload.stage_to = 'exam_scheduled'`

The pipeline guard is required — do not fire on stages named `exam_scheduled` in other pipelines.

**Handler behavior:**
1. Look up `referrals` row by `payload.lead_id` — if not found, skip (lead was not a referred lead)
2. Update: `status = 'exam_scheduled'`, `exam_scheduled_at = payload.transitioned_at`
   - Field name is `transitioned_at` — matches actual Pipeline Engine publisher output. (`@ortho/types` `LeadStageChangedPayload.occurred_at` is a stale type definition corrected in the `@ortho/types` update below.)
3. If `referrals.notify_on_exam = true` AND `referrer.referrer_type = 'patient'` AND referrer `phone` is non-null:
   - Call `POST /messages/send` (Messaging Service) with referrer's `phone` and `dedup_key = "referral_exam_notify:{referral_id}"` to prevent duplicate SMS on SQS redelivery
   - Message body: `notification.service.ts` `buildExamScheduledMessage(referrer)`
4. **Idempotency:** DB status update is idempotent on redelivery; `dedup_key` on Messaging Service call prevents duplicate SMS

#### `lead.converted` → `lead-converted.ts`

Two separate branches in the same handler based on `payload.to_pipeline`:

**Branch A — `to_pipeline = 'in_treatment'` (contract signed):**
1. Look up `referrals` row by `payload.lead_id` — if not found, skip
2. Update: `status = 'converted'`, `converted_at = payload.converted_at`
   - `converted_at` is read from `payload.converted_at` (set by Pipeline Engine publisher at transition time, not from `new Date()`)
3. Insert `reward_events` row: `{ referral_id, referrer_id, status: 'pending' }` — idempotency via `UNIQUE (referral_id)` + `ON CONFLICT DO NOTHING`
4. If `notify_on_conversion = true` AND `referrer_type = 'patient'` AND referrer `phone` is non-null:
   - Call `POST /messages/send` with referrer's `phone` and `dedup_key = "referral_conversion_notify:{referral_id}"` to prevent duplicate SMS on SQS redelivery
   - Message body: `notification.service.ts` `buildConversionMessage(referrer)`
5. Publish `referral.converted` to EventBridge (post-commit)

**Branch B — `to_pipeline = 'in_retention'` (treatment complete → patient referrer creation):**
1. Check if `referrers` row already exists for `lead_id` — if yes, skip (idempotent on SQS redelivery)
2. Call `GET /leads/:lead_id` (Lead Service, `LEAD_SERVICE_API_KEY`) → get `{ first_name, last_name, phone, location_id }`
3. Insert `referrers` row: `{ referrer_type: 'patient', lead_id, location_id, name: first_name + ' ' + last_name, phone, created_by: null }`
4. Insert `referral_links` row with generated `code` and `redirect_url` from `DEFAULT_REFERRAL_LANDING_URL` env var
5. Publish `referrer.created` to EventBridge (post-commit) with `referral_link_url` constructed as `REFERRAL_BASE_URL + '/referrals/r/' + code`. Do **not** use the landing page URL with `?ref=` baked in — that would bypass click tracking.

If Lead Service call fails in Branch B: log error to Datadog + dead-letter the job. Staff can manually create the referrer via `POST /referrals/referrers` as a fallback.

---

## 7. SMS Message Templates

`notification.service.ts` exports two builder functions. Copy is hardcoded with `// TODO: confirm copy with product` comments.

```typescript
// TODO: confirm copy with product
export function buildExamScheduledMessage(referrer: { name: string }): string {
  const firstName = referrer.name.split(' ')[0];
  return `Hi ${firstName}, great news — the patient you referred has scheduled their exam!`;
}

// TODO: confirm copy with product
export function buildConversionMessage(referrer: { name: string }): string {
  const firstName = referrer.name.split(' ')[0];
  return `Hi ${firstName}, the patient you referred has started treatment! We'll be in touch about your reward.`;
}
```

SMS is sent only to patient referrers (`referrer_type = 'patient'`). Doctor referrer SMS notifications are skipped regardless of `notify_on_*` flags.

---

## 8. Service Layout

Two entry points — API server and event worker deployed as separate ECS tasks:

```
apps/crm/referral/
├── src/
│   ├── routes/
│   │   ├── public/                    # encapsulated scope — no authPlugin
│   │   │   ├── links.ts               # GET /referrals/r/:code, GET /referrals/links/:code
│   │   │   └── portal.ts              # GET /referrals/portal/:token
│   │   ├── referrers.ts
│   │   ├── referral-links.ts
│   │   ├── referrals.ts
│   │   ├── rewards.ts
│   │   └── leaderboard.ts
│   ├── services/
│   │   ├── referrer.service.ts        # CRUD + patient referrer creation from event
│   │   ├── link.service.ts            # code generation, click tracking, resolution
│   │   ├── referral.service.ts        # tracking record lifecycle
│   │   ├── reward.service.ts          # pending → issued transitions
│   │   └── notification.service.ts    # builds message body, calls Messaging Service
│   ├── repositories/
│   │   ├── referrer.repo.ts
│   │   ├── referral-link.repo.ts
│   │   ├── referral.repo.ts
│   │   ├── reward.repo.ts
│   │   └── portal-token.repo.ts
│   ├── handlers/                      # event handler functions (shared by worker.ts)
│   │   ├── lead-created.ts
│   │   ├── lead-stage-changed.ts
│   │   └── lead-converted.ts
│   ├── events/
│   │   └── publisher.ts               # referral.converted + referrer.created
│   ├── clients/
│   │   └── lead-service.client.ts     # GET /leads/:id with LEAD_SERVICE_API_KEY
│   ├── env.ts                         # typed env config (no REDIS_URL)
│   ├── index.ts                       # HTTP server entry point (ECS task 1)
│   └── worker.ts                      # event bus worker entry point (ECS task 2)
├── migrations/
├── test/
│   ├── unit/
│   └── integration/
├── Dockerfile
├── package.json
└── tsconfig.json
```

**Runtime dependencies:**
- PostgreSQL (shared RDS cluster, `crm_referrals` schema)
- AWS EventBridge (publish `referral.converted`, `referrer.created`)
- AWS SQS (subscribe via `@ortho/event-bus` EventBridgeDriver — `lead.created`, `lead.stage_changed`, `lead.converted`)
- Messaging Service (REST — SMS notifications)
- Lead Service (REST — `LEAD_SERVICE_API_KEY`, patient info at referrer creation)
- **No Redis · No BullMQ**

---

## 9. Environment Configuration

```bash
# Server
DATABASE_URL=postgres://...
PORT=3000
NODE_ENV=production

# Auth
IDENTITY_JWKS_URL=https://.../.well-known/jwks.json

# Internal service calls
LEAD_SERVICE_URL=http://lead-service:3000
LEAD_SERVICE_API_KEY=sk_lead_...
MESSAGING_SERVICE_URL=http://messaging-service:3000

# Referral link URLs
DEFAULT_REFERRAL_LANDING_URL=https://yourpractice.com/new-patient
REFERRAL_BASE_URL=https://api.yourpractice.com

# Event bus
EVENT_BUS_DRIVER=eventbridge          # or 'redis' for local dev
SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/...
AWS_REGION=us-east-1
```

No `REDIS_URL` — the Referral Service has no Redis dependency.

---

## 10. `@ortho/types` Updates

The following changes to `packages/@ortho/types` are in scope for this implementation:

1. **`LeadStageChangedPayload`** — rename `occurred_at` → `transitioned_at` to match the actual Pipeline Engine publisher output.

2. **`LeadConvertedPayload`** — extend with fields the Pipeline Engine publisher already emits:
   ```typescript
   to_pipeline: 'in_treatment' | 'in_retention';
   converted_at: string;  // ISO timestamp
   ```

3. **`ReferralConvertedPayload`** — new type:
   ```typescript
   interface ReferralConvertedPayload {
     referral_id:   string;
     lead_id:       string;
     referrer_id:   string;
     referrer_type: 'patient' | 'doctor';
     location_id:   string;
     converted_at:  string;
   }
   ```

4. **`ReferrerCreatedPayload`** — new type:
   ```typescript
   interface ReferrerCreatedPayload {
     referrer_id:       string;
     referrer_type:     'patient';
     lead_id:           string;
     location_id:       string;
     referral_link_id:  string;
     referral_code:     string;
     referral_link_url: string;
     created_at:        string;
   }
   ```

5. **`ReferrerCreatedEvent`** — new event envelope type following existing `*Event` conventions.

---

## 11. Testing Strategy

### Unit Tests (Vitest)

- `link.service.ts` — code generation produces 8-char alphanumeric; collision retry logic (up to 5 attempts); returns `500` on 5 consecutive collisions
- `notification.service.ts` — correct phone selected from referrer record; correct message body per notification type (`exam_scheduled`, `converted`); skips when `notify_on_exam = false` or `notify_on_conversion = false`; skips when `referrer_type = 'doctor'`; skips when `phone` is null
- `reward.service.ts` — `400` on double-issue attempt; `issued_at` and `issued_by` set correctly; `reward_type` required on issue

### Integration Tests (Vitest + real Postgres; external HTTP clients mocked via `vi.mock`)

External HTTP dependencies (`lead-service.client.ts` and the Messaging Service fetch wrapper) are mocked using `vi.mock` at the module level — no HTTP at all for external calls in integration tests.

- `lead-created` handler — `referrals` row created pinned to the specific link matching `referral_code`; code not in DB → log warn + skip, no referral row created; skip when `referrer_id` null; idempotent on duplicate delivery
- `lead-stage-changed` handler — status advances to `exam_scheduled`, `exam_scheduled_at` set from `transitioned_at`; SMS sent with correct `dedup_key` for patient referrer; no SMS for doctor referrer; non-`exam_scheduled` stage skipped; `pipeline != 'new_patient'` skipped; missing referral record skipped; `dedup_key` prevents duplicate SMS on second delivery of same event
- `lead-converted` handler (Branch A) — status `converted`; `converted_at` matches `payload.converted_at`; `reward_events` row created with `pending`; `referral.converted` published; SMS sent with `dedup_key`; idempotent on duplicate delivery
- `lead-converted` handler (Branch B) — `referrers` + `referral_links` rows created; `referrer.created` published with `referral_link_url`; idempotent (second delivery skips); Lead Service call failure → dead-letters job
- `GET /referrals/r/:code` — active code: `302` with `?ref=:code` appended + `click_count` incremented; inactive code: `302` without `?ref=` + no increment; unknown code: `404`
- `GET /referrals/links/:code` — `200` with `referrer_id`, `referral_link_id`, `referrer_type`, `referrer_name`; `404` for inactive; `404` for unknown
- `GET /referrals/portal/:token` — `200` with referrer + referrals + correct stats (`total_referrals`, `exams_scheduled`, `cases_started` computed correctly); `404` for unknown token; referral rows omit `lead_id`
- `PATCH /referrals/rewards/:id` — `pending → issued` with `reward_type`, `issued_at`, `issued_by` set; `400` on double-issue; `400` when `reward_type` absent
- `GET /referrals/leaderboard` — correct ranking by `cases_started` DESC; `referrer_type` filter applied; `period_start`/`period_end` scoping uses correct date columns per metric; location scoping for agents
- `POST /referrals/referrers/:id/portal-token` — token generated; regeneration replaces previous token (UPSERT); `400` if `referrer_type = 'patient'`

### Contract Tests

- **Incoming `lead.created` payload shape:** TypeBox schema validation — assert that `referrer_id`, `referrer_type`, and `referral_code` fields are present (even if nullable). Test publishes a synthetic event without these fields and asserts the TypeBox validator rejects it. This validates handler compatibility at deploy time.
- **Outgoing `referral.converted` payload:** all required fields present (`referral_id`, `lead_id`, `referrer_id`, `referrer_type`, `location_id`, `converted_at`)
- **Outgoing `referrer.created` payload:** all required fields present (`referrer_id`, `lead_id`, `location_id`, `referral_link_id`, `referral_code`, `referral_link_url`); assert `referral_link_url` matches pattern `*/referrals/r/<code>` (contains redirect endpoint path, not a landing page URL with `?ref=` baked in)

---

## 12. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Referral attribution flow | Client-side resolution by form widget | Preserves Lead Service's zero-outbound-call pattern at creation time; attribution immutability unaffected; soft-fail on invalid code keeps lead creation robust |
| Specific link pinning | `referral_code` passed through form widget → Lead Service → `lead.created` payload | Ensures `referrals.referral_link_id` is accurate; prevents mis-attribution when a referrer's link is deactivated between click and form submission |
| Sequence enrollment timing | Automation Engine subscribes to `referrer.created` (not `lead.converted`) | Eliminates race condition where Automation Engine fetches referral link before Branch B has committed |
| Patient referrer creation | Reactive on `lead.converted` to `in_retention` | Automatic, no staff action required; idempotent on SQS redelivery |
| Referrer phone storage | Denormalized on `referrers` row at creation | Avoids per-SMS lookup of Lead Service; acceptable stale risk for MVP (patient phones rarely change post-treatment) |
| SMS notifications | Direct call to Messaging Service with `dedup_key` | Simpler than event-based approach; `dedup_key` ensures idempotency on SQS redelivery |
| Event worker pattern | `@ortho/event-bus` `.subscribe()` + `.start()` | No Redis, no BullMQ; identical to Lead Service and Campaign Service; EventBridgeDriver handles SQS polling internally |
| Service entry points | Two ECS tasks (`index.ts` HTTP + `worker.ts` event consumer) | Independent scaling; HTTP server and event worker can be sized separately; consistent with multi-entrypoint pattern used by other high-throughput services |
| Public route auth bypass | Fastify encapsulated scope without `authPlugin` | Cleaner than path-matching hacks; Fastify's plugin encapsulation boundary guarantees isolation; consistent with ADR for auth bypass patterns |
| RBAC permissions | New `referrals:read` / `referrals:write` in `ROLE_PERMISSIONS` | Semantically correct; consistent with how `leads:read`, `campaigns:write`, etc. are modeled across the platform |
| `converted_at` source | `payload.converted_at` from Pipeline Engine | Preserves the authoritative conversion timestamp across services; avoids clock skew from handler processing delay |
| `transitioned_at` field name | Runtime value from Pipeline Engine (`transitioned_at`) over stale `@ortho/types` (`occurred_at`) | `@ortho/types` was wrong; fix the types as part of this implementation |
| No-fallback on unknown link code | Log warn + skip (no fallback to active link) | Mis-attribution is worse than no record; inactive-link case handled upstream by form widget returning `404` for inactive codes |
| Doctor thank-you | Deferred for launch | Doctor relationship managed through manual outreach; SMS optional for doctors; future Campaign Service email campaigns can cover this |
| Reward lifecycle | Two-state (`pending → issued`) | Actionable staff work queue; no approval overhead for MVP |
| Doctor portal auth | Long-lived token in URL | No account management overhead; acceptable for low-sensitivity, read-only view |
| Click tracking redirect | `302` for inactive codes (no `?ref=`) rather than `404` | Prospective patient still reaches practice website; `404` looks broken when shared in SMS/email |
| Code generation | 8-char alphanumeric with collision retry | URL-safe, short for SMS links, negligible collision probability at expected volumes |
| No Redis | Omit entirely | YAGNI; `@ortho/event-bus` handles SQS polling; no scheduling queue needed |
| SMS copy | Hardcoded defaults with `// TODO: confirm copy with product` | MVP pragmatism; avoids Template Service dependency for two simple strings |
| Contract test approach | TypeBox runtime validation | Tests actual payload shape at integration test time; fails if Lead Service fields are absent from the event |
| External HTTP mocking | `vi.mock` on client modules | No HTTP in integration tests for external calls; deterministic; avoids `nock` global patching |

---

## 13. Pending Amendments Required

1. ~~**Lead Service spec** — add `referrer_id`, `referrer_type`, and `referral_code` to `leads` table DDL and `lead.created` event payload.~~ **Status: already implemented.** No changes required.

2. **Arch doc event table** — add:
   - `referral.converted`: publisher = Referral Service, subscribers = Lead Service + Analytics Service
   - `referrer.created`: publisher = Referral Service, subscribers = Automation Engine

3. **Analytics Service spec** — add `referral.converted` handler to the SQS worker.

4. **Automation Engine spec** — add `referrer.created` to the supported event trigger catalog with `entity_type = 'referrer'` and `event_type = 'referrer.created'`. Document that `referral_link_url`, `lead_id`, and `location_id` from the event payload are available as context variables in downstream action steps.

5. ~~**Pipeline Engine spec** — confirm `lead.converted` payload includes `to_pipeline` field.~~ **Status: confirmed.** Pipeline Engine spec Section 6 already includes `to_pipeline` in the `lead.converted` payload. No amendment needed.
