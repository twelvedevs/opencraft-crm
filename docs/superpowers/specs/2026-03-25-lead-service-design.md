# Lead Service — Design Spec

**Date:** 2026-03-25
**Status:** Draft
**Component:** `apps/crm/lead` — product layer service
**DB Schema:** `crm_leads`

---

## 1. Overview

The Lead Service is the core entity store for all leads in Ortho CRM. It is a product-layer service with full knowledge of Ortho CRM concepts — pipelines, stages, attribution channels, coordinators, and appointments.

### 1.1 Responsibilities

- Lead records with immutable first-touch attribution (locked at creation)
- Duplicate detection on creation and coordinator-driven merge
- Appointment records (exam bookings entered manually by coordinators) — Lead Service stores them and publishes `appointment.updated` so Pipeline Engine can transition stage and Nurturing Engine can enroll in confirmation sequences
- Activity timeline — materialized projection of domain events from multiple services, written by an SQS worker
- Custom tag registry and lead-tag assignments
- `contact_status` enum maintained via opt-out and email bounce events
- Denormalized `current_pipeline` + `current_stage` cache — updated via `lead.stage_changed` events; Pipeline Engine remains authoritative
- Rule-based priority score — recalculated synchronously inside the SQS worker on relevant events

### 1.2 Explicitly Out of Scope

- **Stage transition validation** — Pipeline Engine's responsibility; Lead Service calls Pipeline Engine on merge when stage must change
- **SMS/email sending** — Messaging Service and Email Service
- **Conversation threading** — Conversation Service bridges Messaging Service ↔ Lead records
- **Consent tracking for photos** — Media Service stores files; Lead Service only stores `media_file_id` reference if needed
- **CSV parsing and column mapping** — Data Import Service calls Lead Service API after parsing and matching
- **Lead scoring commentary computation** — AI Service handles it on-demand; Lead Service calls `POST /ai/complete` and returns the result

---

## 2. Architecture

```
                           ┌─────────────────────┐
  POST /leads              │                     │
  ──────────────────────►  │    Lead Service     │ ──► EventBridge: lead.created
  PATCH /leads/:id         │                     │                   lead.updated
  POST /leads/:id/merge    │  crm_leads schema   │                   lead.merged
  POST /leads/:id/appts    │                     │                   lead.archived
                           │                     │                   appointment.updated
                           └──────────┬──────────┘
                                      │
                              SQS Worker (BullMQ)
                                      │
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
    ad_lead.received         lead.stage_changed          opt_out.received
    (Integration Hub)        (Pipeline Engine)           email.bounced
                                                         message.delivered
                                                         inbound_message.received
                                                         referral.converted
                                                         sequence.step_completed
                                                         workflow.triggered
```

**Event ingestion:** EventBridge routes all subscribed events to one SQS queue. A BullMQ worker inside Lead Service polls the queue and dispatches to typed handlers. Each handler runs atomically — state updates + timeline insert in a single DB transaction.

---

## 3. Data Model

### 3.1 `leads` Table

Core entity. Attribution fields are immutable after creation — enforced at the service layer (`PATCH /leads/:id` rejects any attribution field with `400`).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `location_id` | uuid | assigned location |
| `first_name` | varchar | |
| `last_name` | varchar | |
| `phone` | varchar | normalized E.164 |
| `email` | varchar nullable | |
| `treatment_interest` | varchar nullable | e.g. braces, Invisalign |
| `channel` | enum | `website_form \| google_ads \| facebook_ads \| call_tracking \| referral \| walk_in \| chat \| google_business_profile \| csv_import` |
| `contact_status` | enum | `active \| sms_opted_out \| email_invalid \| fully_unreachable` |
| `current_pipeline` | enum | `new_patient \| in_treatment \| in_retention \| none` — denormalized cache |
| `current_stage` | varchar | stage name within pipeline — denormalized cache |
| `score` | smallint | 0–100, recalculated on events |
| `duplicate_status` | enum | `none \| flagged \| resolved` |
| `duplicate_of_id` | uuid nullable | points to primary lead if flagged |
| `merged_into_id` | uuid nullable | set when this lead is merged away |
| `archived_at` | timestamptz nullable | soft delete |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

**Attribution columns** (all on `leads` table, all immutable after creation):

| Column | Type |
|---|---|
| `first_touch_source` | varchar nullable |
| `first_touch_medium` | varchar nullable |
| `first_touch_campaign` | varchar nullable |
| `first_touch_ad` | varchar nullable |
| `first_touch_keyword` | varchar nullable |
| `first_touch_landing_page` | varchar nullable |
| `first_touch_referring_url` | varchar nullable |
| `first_touch_device` | varchar nullable |
| `call_tracking_number` | varchar nullable |
| `referrer_id` | uuid nullable |
| `ad_platform_lead_id` | varchar nullable |
| `created_by_location` | uuid nullable |

### 3.2 `appointments` Table

Exam and follow-up bookings entered manually by coordinators. Appointment status changes trigger `appointment.updated` events so Pipeline Engine and Nurturing Engine can react.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `lead_id` | uuid FK → leads | |
| `location_id` | uuid | |
| `appointment_type` | enum | `exam \| follow_up \| other` |
| `scheduled_at` | timestamptz | |
| `status` | enum | `scheduled \| completed \| cancelled \| no_show` |
| `notes` | text nullable | |
| `created_by` | uuid | coordinator user ID |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### 3.3 `lead_activities` Table

Materialized timeline. Written exclusively by the SQS worker (and by Lead Service itself for its own mutations). `source_event_id` is the idempotency key — `ON CONFLICT (source_event_id) DO NOTHING` prevents duplicate entries on SQS redelivery.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `lead_id` | uuid FK → leads | |
| `event_type` | varchar | e.g. `lead.created`, `lead.stage_changed`, `message.delivered` |
| `actor_type` | enum | `system \| staff \| automation` |
| `actor_id` | uuid nullable | user ID or service sentinel UUID |
| `payload` | jsonb | event-specific data |
| `occurred_at` | timestamptz | |
| `source_event_id` | varchar nullable | original EventBridge event ID — idempotency key |

### 3.4 `tags` Table

Tag registry — controls vocabulary for coordinators and enables Audience Engine filter evaluation against lead tags.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | varchar | |
| `location_id` | uuid nullable | null = global tag available to all locations |
| `created_by` | uuid | |
| `created_at` | timestamptz | |

Unique constraint: `(name, location_id)`.

### 3.5 `lead_tags` Join Table

`(lead_id, tag_id)` composite PK. Additional columns: `applied_by uuid`, `applied_at timestamptz`.

### 3.6 `lead_merges` Audit Log

| Column | Type |
|---|---|
| `id` | uuid PK |
| `surviving_lead_id` | uuid FK → leads |
| `merged_lead_id` | uuid FK → leads |
| `merged_by` | uuid |
| `merged_at` | timestamptz |
| `stage_chosen` | varchar |

### 3.7 Indexes

| Index | Type | Purpose |
|---|---|---|
| `leads(phone)` | B-tree | Dedup lookup |
| `leads(email)` | B-tree | Dedup lookup |
| `leads(location_id)` | B-tree | List queries |
| `leads(current_pipeline, current_stage)` | B-tree | Filtered list queries |
| `leads(first_name, last_name)` | GIN trigram | Name search |
| `leads(phone)` | GIN trigram | Partial phone search |
| `leads(email)` | GIN trigram | Partial email search |
| `lead_activities(lead_id, occurred_at DESC)` | B-tree | Timeline queries |
| `lead_activities(source_event_id)` | B-tree unique | Idempotency |
| `appointments(lead_id)` | B-tree | Per-lead appointment list |
| `appointments(location_id, scheduled_at)` | B-tree | Coordinator schedule view |

---

## 4. API Design

All routes require a valid JWT via `@ortho/auth-middleware`. Location scoping enforced via `require-location.ts` — agents see only their assigned location(s); marketing managers see all locations.

### 4.1 Leads

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST /leads` | Create lead | Any staff | Runs dedup check inline. Returns `201` with lead + `duplicate_status` if flagged. |
| `GET /leads` | List leads | Any staff | Filter: `location_id`, `pipeline`, `stage`, `contact_status`, `channel`, `tag_id[]`, `q` (trigram search), `sort` (`score\|created_at\|last_activity_at`). Paginated (cursor). |
| `GET /leads/:id` | Get lead | Any staff | Full record: attribution, current tags, score, current appointments. |
| `PATCH /leads/:id` | Update mutable fields | Coordinator+ | Accepts: `first_name`, `last_name`, `phone`, `email`, `treatment_interest`, `location_id`. Rejects attribution fields with `400`. |
| `DELETE /leads/:id` | Archive lead | Manager+ | Soft delete — sets `archived_at`. |

### 4.2 Deduplication & Merge

| Method | Path | Notes |
|---|---|---|
| `GET /leads/duplicates` | List flagged duplicates | For coordinator review queue. Scoped to caller's locations. |
| `POST /leads/:id/merge` | Merge two leads | Body: `{ merge_lead_id, winning_stage }`. Surviving record = `:id`. Calls Pipeline Engine to set stage if different. Writes `lead_merges` entry. Publishes `lead.merged`. |
| `PATCH /leads/:id/duplicate-status` | Resolve duplicate flag | Body: `{ status: "resolved" }` — coordinator confirmed not a duplicate. |

### 4.3 Tags

| Method | Path | Notes |
|---|---|---|
| `GET /tags` | List tags | Query: `location_id` — returns matching location tags + global tags. |
| `POST /tags` | Create tag | Marketing Manager+ |
| `DELETE /tags/:id` | Delete tag | Removes from all leads. Marketing Manager+. |
| `POST /leads/:id/tags` | Apply tag to lead | Body: `{ tag_id }`. |
| `DELETE /leads/:id/tags/:tag_id` | Remove tag from lead | |

### 4.4 Appointments

| Method | Path | Notes |
|---|---|---|
| `POST /leads/:id/appointments` | Create appointment | Publishes `appointment.updated`. |
| `PATCH /leads/:id/appointments/:appt_id` | Update appointment | Status changes (`completed`, `no_show`, `cancelled`) publish `appointment.updated`. |
| `GET /leads/:id/appointments` | List appointments for lead | |

### 4.5 Activity Timeline

| Method | Path | Notes |
|---|---|---|
| `GET /leads/:id/activities` | Get timeline | Paginated cursor, `occurred_at DESC`. Optional filter: `event_type[]`. |

### 4.6 Score Commentary

| Method | Path | Notes |
|---|---|---|
| `GET /leads/:id/score-commentary` | AI explanation of score | Calls `POST /ai/complete` with `prompt_id: "lead_score_commentary"` + lead context. Returns `{ score, commentary }`. AI Service handles response caching. |

---

## 5. Events

### 5.1 Events Published

| Event | Trigger | Key Payload Fields |
|---|---|---|
| `lead.created` | New lead created | `lead_id`, `location_id`, `channel`, `current_pipeline`, `current_stage` |
| `lead.updated` | Mutable fields changed | `lead_id`, `location_id`, `changed_fields[]` |
| `lead.merged` | Merge completed | `surviving_lead_id`, `merged_lead_id`, `location_id` |
| `lead.archived` | Lead archived | `lead_id`, `location_id` |
| `appointment.updated` | Appointment created or status changed | `lead_id`, `appointment_id`, `appointment_type`, `scheduled_at`, `status`, `location_id` |

### 5.2 Events Subscribed (SQS Worker)

| Event | Source | State Update | Timeline Entry |
|---|---|---|---|
| `ad_lead.received` | Integration Hub | Create lead (same path as `POST /leads`) | yes — `lead.created` activity |
| `lead.stage_changed` | Pipeline Engine | Update `current_pipeline` + `current_stage`; recalculate score | yes |
| `lead.converted` | Pipeline Engine | Set `current_pipeline = none`, `current_stage = converted`; recalculate score | yes |
| `opt_out.received` | Messaging Service | Set `contact_status` → `sms_opted_out` or `fully_unreachable` (if email already invalid); recalculate score | yes |
| `opt_out.removed` | Messaging Service | Restore `contact_status` → `active` or `email_invalid`; recalculate score | yes |
| `email.bounced` | Email Service | Set `contact_status` → `email_invalid` or `fully_unreachable` (if SMS opted out); recalculate score | yes |
| `message.delivered` | Messaging Service | Recalculate score | yes |
| `message.failed` | Messaging Service | — | yes |
| `inbound_message.received` | Messaging Service | Recalculate score (lead responded → urgency up) | yes |
| `referral.converted` | Referral Service | — | yes |
| `sequence.step_completed` | Nurturing Engine | — | yes |
| `workflow.triggered` | Automation Engine | — | yes |

---

## 6. Key Behaviors

### 6.1 Deduplication

On every `POST /leads` (and `ad_lead.received` handler), Lead Service checks for phone OR email match against non-archived, non-merged-away leads:

- Exact E.164 phone match → flag as duplicate
- Exact email match (case-insensitive) → flag as duplicate
- No match → create with `duplicate_status: none`

When flagged: lead is created (not blocked), `duplicate_status` set to `flagged`, `duplicate_of_id` points to the oldest matching lead. Both leads remain active until a coordinator resolves. `lead.created` is still published — downstream services will enroll the new lead in sequences. Merging cleans up in-flight sequences via `lead.merged`.

Data Import Service passes matched lead IDs directly to `PATCH /leads/:id` after its own 5-tier match logic — it does not go through the dedup creation path for records it has already matched.

### 6.2 Merge

`POST /leads/:id/merge` with `{ merge_lead_id, winning_stage }`:

1. Validate both leads exist, are not already merged, belong to accessible locations
2. If `winning_stage` differs from surviving lead's current stage → call Pipeline Engine `POST /pipeline/leads/:id/transition`; fail merge (rollback) if Pipeline Engine rejects
3. Copy all `lead_activities` from merged lead → surviving lead (preserving `occurred_at`)
4. Copy `lead_tags` from merged lead not already on surviving lead
5. Set `merged_lead.merged_into_id = surviving_lead.id`, `merged_lead.archived_at = now()`
6. Write `lead_merges` audit row
7. Publish `lead.merged`

Attribution: surviving lead's first-touch attribution is preserved unchanged. The merged-away lead's attribution is readable in the `lead_merges` audit log.

### 6.3 Score Computation

`score-calculator.ts` is a pure function — takes the lead record + triggering event payload, returns a `smallint` 0–100. No I/O.

| Factor | Effect |
|---|---|
| Stage time limit proximity | Days remaining < 20% of limit → urgency boost |
| Inbound message received | +weight (lead is engaged and responding) |
| Last inbound message age | No response in >3 days → urgency boost |
| Stage value weight | `tx_presented` > `exam_completed` > `exam_scheduled` > `contacted` > `new_lead` |
| `contact_status` | `sms_opted_out` or `email_invalid` → penalty; `fully_unreachable` → floor at 5 |

Score drives coordinator queue order in `GET /leads?sort=score`.

### 6.4 Search

`GET /leads?q=smith` — trigram similarity search across `first_name || ' ' || last_name`, `phone`, `email` using `pg_trgm` GIN indexes. Results ordered by similarity score descending, then `leads.score` descending as tiebreaker. Minimum similarity threshold: `0.2` (configurable via `SEARCH_SIMILARITY_THRESHOLD` env var).

### 6.5 Contact Status Transitions

```
active ──────────────────────────────────────► sms_opted_out
  │                                                  │
  │ (email.bounced)                   (email.bounced)│
  ▼                                                  ▼
email_invalid ──────────────────────────► fully_unreachable
```

`opt_out.removed` restores from `sms_opted_out` → `active`, or from `fully_unreachable` → `email_invalid`.

---

## 7. Internal Structure

```
apps/crm/lead/
├── src/
│   ├── routes/
│   │   ├── leads.ts
│   │   ├── appointments.ts
│   │   ├── tags.ts
│   │   └── activities.ts
│   ├── services/
│   │   ├── lead-service.ts          # CRUD, dedup check
│   │   ├── merge-service.ts         # merge orchestration
│   │   ├── appointment-service.ts
│   │   └── tag-service.ts
│   ├── repositories/
│   │   ├── lead-repository.ts
│   │   ├── activity-repository.ts
│   │   ├── appointment-repository.ts
│   │   └── tag-repository.ts
│   ├── workers/
│   │   ├── event-worker.ts          # BullMQ worker, SQS polling
│   │   └── handlers/
│   │       ├── ad-lead-received.ts
│   │       ├── stage-changed.ts
│   │       ├── opt-out-received.ts
│   │       ├── opt-out-removed.ts
│   │       ├── email-bounced.ts
│   │       ├── message-delivered.ts
│   │       ├── message-failed.ts
│   │       ├── inbound-message-received.ts
│   │       ├── referral-converted.ts
│   │       ├── sequence-step-completed.ts
│   │       └── workflow-triggered.ts
│   ├── events/
│   │   └── publisher.ts             # lead.created, lead.updated, lead.merged, etc.
│   ├── scoring/
│   │   └── score-calculator.ts      # pure function, no I/O
│   └── index.ts
├── migrations/
├── test/
├── Dockerfile
├── package.json
└── tsconfig.json
```

---

## 8. Error Handling

| Scenario | Response |
|---|---|
| `POST /leads` with attribution field in `PATCH /leads/:id` | `400 Bad Request` — `{ error: "attribution fields are immutable" }` |
| `POST /leads/:id/merge` — Pipeline Engine rejects transition | `422 Unprocessable Entity` — `{ error: "pipeline engine rejected stage transition: <reason>" }` |
| `GET /leads/:id/score-commentary` — AI Service unavailable | `503 Service Unavailable` — pass through AI Service error |
| SQS handler processes unknown `lead_id` | Log warn + skip — lead may have been archived; do not dead-letter |
| SQS handler DB failure | Job retries via BullMQ backoff; after max retries → dead-letter queue + Datadog alert |
