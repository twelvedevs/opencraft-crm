# Lead Service — Updated Design Spec

**Date:** 2026-04-06
**Status:** Approved
**Supersedes:** `docs/superpowers/specs/2026-03-25-lead-service-design.md`
**Component:** `apps/crm/lead` — product layer service
**DB Schema:** `crm_leads`

---

## Changelog from Original Spec

| Area | Change |
|---|---|
| Event worker | BullMQ removed — use `@ortho/event-bus` directly (`bus.subscribe()` + `bus.start()`) |
| Initial score | Clarified: `0` at creation; `score-calculator.ts` is NOT called inline at creation |
| Location scoping | `requireLocation()` not used — location scoping applied in repository queries via `req.user.locations` |
| Cursor pagination | Opaque base64 keyset cursor encoding `(last_seen_id, last_seen_sort_value)` |
| Phone normalization | `libphonenumber-js` for E.164 normalization |
| `@ortho/types` | Lead Service event types and subscribed payload types added to `@ortho/types/src/events.ts` |
| Knex setup | Instantiated directly in `src/db.ts` — no `@ortho/db` package |
| `lead.archived` dual origin | HTTP DELETE publishes `lead.archived`; worker handler always uses internal idempotency key — prevents duplicate timeline entries regardless of origin |
| Environment variables | Full list documented including AWS SDK vars and `SERVICE_AUTH_TOKEN` |
| Health endpoint | `GET /health` added — no JWT, returns `{ ok: true }` |
| Duplicates sort | `GET /leads/duplicates` sorted `created_at DESC` |
| TypeBox validation | TypeBox schemas registered via `schema: { body, querystring, params }` on all routes |
| Logger name | `createLogger('crm-lead')` |
| Test scope | Unit tests (mocked DB + MockDriver) + integration tests (real DB + Redis) |
| Phasing | Three phases: core CRUD → dedup/merge/scoring → event worker + handlers |
| Bulk lookup limits | `phones[]` and `emails[]` capped at 100 per call |
| Global tag uniqueness | Partial unique index `UNIQUE (name) WHERE location_id IS NULL` |
| Merge timeout | Pipeline Engine timeout → `503` immediately, no partial state written |
| `GET /leads/:id` | Returns lead + tags + appointments only — no activities embedded |
| `lead.converted` | Handler writes a timeline entry before setting transient state |

---

## 1. Overview

The Lead Service is the core entity store for all leads in Ortho CRM. It is a product-layer service with full knowledge of Ortho CRM concepts — pipelines, stages, attribution channels, coordinators, and appointments.

### 1.1 Responsibilities

- Lead records with immutable first-touch attribution (locked at creation)
- Duplicate detection on creation and coordinator-driven merge
- Appointment records (exam bookings entered manually by coordinators) — Lead Service stores them and publishes `appointment.updated` so Pipeline Engine can transition stage and Nurturing Engine can enroll in confirmation sequences
- Activity timeline — materialized projection of domain events from multiple services, written by the event bus worker
- Custom tag registry and lead-tag assignments
- `contact_status` enum maintained via opt-out and email bounce events
- Denormalized `current_pipeline` + `current_stage` + `last_activity_at` cache — updated via events; Pipeline Engine remains authoritative for stage state
- Rule-based priority score — `0` at creation; recalculated synchronously inside the event worker on relevant events

### 1.2 Explicitly Out of Scope

- **Stage transition validation** — Pipeline Engine's responsibility; Lead Service calls Pipeline Engine on merge when stage must change
- **SMS/email sending** — Messaging Service and Email Service
- **Conversation threading** — Conversation Service bridges Messaging Service ↔ Lead records
- **Consent tracking for photos** — Media Service stores files; Lead Service only stores `media_file_id` reference if needed
- **CSV parsing and column mapping** — Data Import Service calls Lead Service API after parsing and matching
- **Lead scoring commentary computation** — AI Service handles on-demand; Lead Service calls `POST /ai/complete` and returns the result
- **Audience Engine push** — Lead Service does not call Audience Engine directly. Campaign Service fetches leads from `GET /leads` and submits entity data to Audience Engine. Lead Service is the data source; Campaign Service orchestrates the evaluation call.

---

## 2. Architecture

```
                           ┌─────────────────────┐
  POST /leads              │                     │
  ──────────────────────►  │    Lead Service     │ ──► EventBridge: lead.created
  PATCH /leads/:id         │                     │                  lead.updated
  POST /leads/:id/merge    │  crm_leads schema   │                  lead.merged
  POST /leads/:id/appts    │                     │                  lead.archived
                           │                     │                  appointment.updated
                           └──────────┬──────────┘
                                      │
                        @ortho/event-bus Worker
                        (bus.subscribe × 13 handlers)
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

**Event ingestion:** EventBridge routes all subscribed events to one SQS queue. The `@ortho/event-bus` worker (`EventBridgeDriver` in prod, `RedisStreamsDriver` locally) handles polling and at-least-once delivery. All 13 event subscriptions are registered via `bus.subscribe()` before `bus.start()`. Each handler runs atomically — state updates + timeline insert in a single DB transaction.

**No BullMQ dependency.** Retry/backoff semantics are provided by the SQS visibility timeout (`EventBridgeDriver`) and the Redis DLQ (`RedisStreamsDriver`). After the max retry threshold the event bus moves the message to the dead-letter stream and emits a Datadog alert.

---

## 3. Data Model

### 3.1 `leads` Table

Core entity. Attribution fields are immutable after creation — enforced at the service layer (`PATCH /leads/:id` rejects any attribution field with `400`).

Archived and merged-away leads remain queryable via `GET /leads/:id` — soft delete only, no physical removal. `GET /leads` (list) excludes archived leads by default; `?include_archived=true` overrides.

`score` defaults to `0` at creation. It is recalculated only inside the event worker on relevant events — not inline during `POST /leads`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `location_id` | uuid | assigned location |
| `first_name` | varchar | |
| `last_name` | varchar | |
| `phone` | varchar | normalized E.164 via `libphonenumber-js` |
| `email` | varchar nullable | |
| `treatment_interest` | varchar nullable | e.g. braces, Invisalign |
| `date_of_birth` | date nullable | used for 5-tier match logic in Data Import Service |
| `channel` | enum | `website_form \| google_ads \| facebook_ads \| call_tracking \| referral \| walk_in \| chat \| google_business_profile \| csv_import` |
| `contact_status` | enum | `active \| sms_opted_out \| email_invalid \| fully_unreachable` |
| `current_pipeline` | enum | `new_patient \| in_treatment \| in_retention \| none` — denormalized cache; default `none` at creation |
| `current_stage` | varchar nullable | stage name within pipeline — denormalized cache; `null` at creation until Pipeline Engine places lead in a stage |
| `last_activity_at` | timestamptz nullable | denormalized — updated whenever a new `lead_activities` row is written; drives `sort=last_activity_at` on list endpoint |
| `score` | smallint | 0–100, default `0` at creation; recalculated by event worker on relevant events |
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
| `referrer_type` | varchar nullable | `patient` or `doctor` — type of referrer; set when `referrer_id` is non-null |
| `referral_code` | varchar nullable | the referral link code used by the prospective patient on the intake form |
| `ad_platform_lead_id` | varchar nullable |
| `created_by_location` | uuid nullable |

### 3.2 `appointments` Table

Exam and follow-up bookings entered manually by coordinators. Appointment status changes trigger `appointment.updated` events so Pipeline Engine and Nurturing Engine can react.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `lead_id` | uuid FK → leads | |
| `location_id` | uuid | location where appointment was booked; not updated if lead's `location_id` is later reassigned |
| `appointment_type` | enum | `exam \| follow_up \| other` |
| `scheduled_at` | timestamptz | |
| `status` | enum | `scheduled \| completed \| cancelled \| no_show` |
| `notes` | text nullable | |
| `created_by` | uuid | coordinator user ID |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### 3.3 `lead_activities` Table

Materialized timeline. Written by the event worker for external events and by Lead Service itself for its own mutations (create, update, merge, archive). `source_event_id` is the idempotency key — `ON CONFLICT (source_event_id) DO NOTHING` on the unique index prevents duplicate entries.

**Source event ID strategy:**

For SQS-sourced entries from external services: `source_event_id` = the EventBridge event ID (guaranteed unique per publish).

For Lead Service-originated activities and for the `lead.archived` worker handler (regardless of who published it): `source_event_id` uses a stable semantic internal key:
- `lead.created` → `"internal:lead.created:{lead_id}"`
- `lead.updated` → `"internal:lead.updated:{lead_id}:{updated_at_iso}"`
- `lead.merged` → `"internal:lead.merged:{surviving_lead_id}:{merged_lead_id}"`
- `lead.archived` → `"internal:lead.archived:{lead_id}"` — used by both the HTTP archive route (written inline) and the `lead.archived` event worker handler (written on worker receipt). The unique constraint ensures only one timeline entry per lead regardless of whether the archive originated from an HTTP call or a Pipeline Engine event.

This scheme prevents duplicate timeline entries when:
- A coordinator archives via HTTP (`DELETE /leads/:id`) and Lead Service also receives its own `lead.archived` event
- Pipeline Engine archives a lead (publishes `lead.archived`) and the worker processes it

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `lead_id` | uuid FK → leads | |
| `event_type` | varchar | e.g. `lead.created`, `lead.stage_changed`, `message.delivered` |
| `actor_type` | enum | `system \| staff \| automation` |
| `actor_id` | uuid nullable | user ID or service sentinel UUID |
| `payload` | jsonb | event-specific data |
| `occurred_at` | timestamptz | |
| `source_event_id` | varchar | idempotency key; never null |

### 3.4 `tags` Table

Tag registry — controls vocabulary for coordinators and enables Audience Engine filter evaluation against lead tags.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | varchar | |
| `location_id` | uuid nullable | null = global tag available to all locations |
| `created_by` | uuid | |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

**Uniqueness:** Two indexes enforce uniqueness:
1. Standard B-tree unique index on `(name, location_id)` — enforces per-location tag name uniqueness
2. Partial unique index `UNIQUE (name) WHERE location_id IS NULL` — enforces one global tag per name (PostgreSQL treats two `NULL` values as distinct in standard unique indexes, so the partial index is required)

### 3.5 `lead_tags` Join Table

`(lead_id, tag_id)` composite PK. Additional columns: `applied_by uuid`, `applied_at timestamptz`.

### 3.6 `lead_merges` Audit Log

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `surviving_lead_id` | uuid FK → leads | |
| `merged_lead_id` | uuid FK → leads | |
| `merged_lead_location_id` | uuid | location of merged-away lead at time of merge — self-contained audit without querying archived row |
| `merged_by` | uuid | |
| `merged_at` | timestamptz | |
| `stage_chosen` | varchar | |

### 3.7 Indexes

| Index | Type | Purpose |
|---|---|---|
| `leads(phone)` | B-tree | Dedup lookup and opt-out/message event phone resolution |
| `leads(email)` | B-tree | Dedup lookup and email bounce event resolution |
| `leads(ad_platform_lead_id)` | B-tree | Idempotency check in `ad_lead.received` handler |
| `leads(location_id)` | B-tree | List queries |
| `leads(current_pipeline, current_stage)` | B-tree | Filtered list queries |
| `leads(score DESC)` | B-tree | Coordinator queue sort |
| `leads(last_activity_at DESC)` | B-tree | Sort by latest activity |
| `leads(first_name, last_name)` | GIN trigram | Name search |
| `leads(phone)` | GIN trigram | Partial phone search |
| `leads(email)` | GIN trigram | Partial email search |
| `lead_activities(lead_id, occurred_at DESC)` | B-tree | Timeline queries |
| `lead_activities(source_event_id)` | B-tree unique | Idempotency |
| `appointments(lead_id)` | B-tree | Per-lead appointment list |
| `appointments(location_id, status, scheduled_at)` | B-tree | Coordinator schedule view |
| `tags(name) WHERE location_id IS NULL` | B-tree unique (partial) | Global tag name uniqueness |

---

## 4. API Design

All routes require a valid JWT via `@ortho/auth-middleware`. The `authPlugin` is registered before all routes; `GET /health` is listed in `allowedPaths`.

**Location scoping:** `requireLocation()` from `@ortho/auth-middleware` is NOT used. Location access is enforced in repository queries: `WHERE location_id = ANY($userLocations)`. When `req.user.locations` is an empty array (marketing, super_admin roles), the location filter is omitted — those roles see all locations.

**Request validation:** TypeBox schemas (`@sinclair/typebox`) registered via `schema: { body, querystring, params }` on each route. Fastify compiles them for fast-json-stringify validation.

### 4.0 Health

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET /health` | Health check | None | Returns `{ ok: true }` with `200`. Listed in `allowedPaths` on authPlugin. |

### 4.1 Leads

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST /leads` | Create lead | Any staff | Runs dedup check inline. Returns `201` with lead + `duplicate_status` if flagged. Phone normalized to E.164 via `libphonenumber-js`. |
| `GET /leads` | List leads | Any staff | Filter: `location_id`, `pipeline`, `stage`, `status` (active\|archived, default active), `contact_status`, `channel`, `tag_id[]`, `q` (trigram search), `include_archived` (default false), `sort` (`score\|created_at\|last_activity_at`). Bulk lookup: `phones[]` (≤100 per call), `emails[]` (≤100 per call), `ids[]` (≤500 per call, batch fetch by PK). Returns `400` if any limit is exceeded. Paginated (opaque keyset cursor — see §6.5). |
| `GET /leads/:id` | Get lead | Any staff | Returns lead record + current tags + current appointments. No activities embedded — use `GET /leads/:id/activities`. Returns archived and merged-away leads. |
| `PATCH /leads/:id` | Update mutable fields | Coordinator+ for name/phone/email/treatment_interest; Manager+ for `location_id` reassignment | Accepts: `first_name`, `last_name`, `phone`, `email`, `treatment_interest`. `location_id` reassignment restricted to `call_center_manager` or higher; publishes `lead.updated` with `changed_fields: ["location_id"]`; appointments keep their original `location_id`. Rejects attribution fields with `400`. |
| `DELETE /leads/:id` | Archive lead | Manager+ | Soft delete — sets `archived_at`. Publishes `lead.archived` via event bus. Writes timeline entry inline with `source_event_id = "internal:lead.archived:{lead_id}"`. When the worker later receives this event, the unique constraint prevents a duplicate timeline entry. |

### 4.2 Deduplication & Merge

| Method | Path | Notes |
|---|---|---|
| `GET /leads/duplicates` | List flagged duplicates | For coordinator review queue. Scoped to caller's locations. Sorted `created_at DESC` (newest first). Paginated (cursor). |
| `POST /leads/:id/merge` | Merge two leads | Body: `{ merge_lead_id, winning_stage }`. Surviving record = `:id`. Calls Pipeline Engine `POST /pipeline/leads/:id/transition` if stage differs — returns `503` immediately on any Pipeline Engine error or timeout (no retry, no partial state written). Writes `lead_merges` entry. Publishes `lead.merged`. |
| `PATCH /leads/:id/duplicate-status` | Resolve duplicate flag | Body: `{ status: "resolved" }` — coordinator confirmed not a duplicate. |

### 4.3 Tags

| Method | Path | Notes |
|---|---|---|
| `GET /tags` | List tags | Query: `location_id` — returns matching location tags + global tags. |
| `POST /tags` | Create tag | Marketing Manager+. Returns `409` if a tag with the same name already exists for the given location (or globally if `location_id` is null). |
| `DELETE /tags/:id` | Delete tag | Removes from all leads. Marketing Manager+. |
| `POST /leads/:id/tags` | Apply tag to lead | Body: `{ tag_id }`. |
| `DELETE /leads/:id/tags/:tag_id` | Remove tag from lead | |

### 4.4 Appointments

| Method | Path | Notes |
|---|---|---|
| `POST /leads/:id/appointments` | Create appointment | Sets initial `status = scheduled`. Publishes `appointment.updated` with `status: "scheduled"`. |
| `PATCH /leads/:id/appointments/:appt_id` | Update appointment | Status changes (`completed`, `no_show`, `cancelled`) publish `appointment.updated` with the new status. |
| `DELETE /leads/:id/appointments/:appt_id` | Delete appointment | Hard delete. Used by Data Import Service undo phase to reverse exam_scheduled transitions. Does not publish `appointment.updated`. Requires `SERVICE_AUTH_TOKEN` header — internal service-to-service use only. |
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

All published event types are defined in `@ortho/types/src/events.ts`.

| Event | Trigger | Key Payload Fields |
|---|---|---|
| `lead.created` | New lead created | `lead_id`, `location_id`, `channel`, `current_pipeline: "none"`, `current_stage: null`, `referrer_id?`, `referrer_type?`, `referral_code?` |
| `lead.updated` | Mutable fields changed | `lead_id`, `location_id`, `changed_fields[]` |
| `lead.merged` | Merge completed | `surviving_lead_id`, `merged_lead_id`, `location_id` |
| `lead.archived` | Lead archived (HTTP or Pipeline Engine event) | `lead_id`, `location_id` |
| `appointment.updated` | Appointment created or status changed | `lead_id`, `appointment_id`, `appointment_type`, `scheduled_at`, `status`, `location_id` |

### 5.2 Events Subscribed (Event Bus Worker)

Subscribed event payload types are defined in `@ortho/types/src/events.ts`. All 13 subscriptions are registered via `bus.subscribe()` before `bus.start()`. Each handler runs atomically — state updates + timeline insert in a single DB transaction.

| Event | Source | Expected Payload Fields | State Update | Timeline Entry |
|---|---|---|---|---|
| `ad_lead.received` | Integration Hub | `platform`, `external_lead_id`, `campaign_id`, `ad_set_id?`, `ad_id?`, `form_id?`, `location_id`, `fields: { full_name, phone_number, email }` | Create lead (idempotency: check `ad_platform_lead_id` first — skip if exists). Phone normalized via `libphonenumber-js`. Run standard dedup check. | yes — `lead.created` activity |
| `lead.stage_changed` | Pipeline Engine | `lead_id`, `location_id`, `pipeline`, `stage_to`, `stage_from`, `reason`, `time_in_stage_seconds`, `response_time_seconds?` | Update `current_pipeline`, `current_stage`; recalculate score | yes |
| `lead.archived` | Pipeline Engine or Lead Service | `lead_id`, `location_id` | Clear `current_pipeline = null`, `current_stage = null`; recalculate score. Uses `source_event_id = "internal:lead.archived:{lead_id}"` — no-op if HTTP archive handler already wrote this entry. | yes (no-op on conflict) |
| `lead.converted` | Pipeline Engine | `lead_id`, `location_id`, `channel` | Write timeline entry first. Then set `current_pipeline = none`, `current_stage = null` as a transient intermediate state — Pipeline Engine immediately follows with `lead.stage_changed` for the new pipeline's initial stage, which overwrites these values. | yes |
| `opt_out.received` | Messaging Service | `phone_number`, `opted_out_at`, `source: 'stop_reply'` — resolve lead via `leads.phone` lookup | Set `contact_status` → `sms_opted_out` or `fully_unreachable` (if email already invalid); recalculate score | yes |
| `opt_out.removed` | Messaging Service | `phone_number`, `removed_at` — resolve lead via `leads.phone` lookup | Restore `contact_status` → `active` or `email_invalid`; recalculate score | yes |
| `email.bounced` | Email Service | `to_address`, `bounce_type: "hard\|soft"` — look up lead via `leads.email = to_address` | Set `contact_status` → `email_invalid` or `fully_unreachable` (if SMS opted out) on hard bounce only; recalculate score | yes |
| `message.delivered` | Messaging Service | `message_id`, `twilio_sid`, `to_number`, `from_number`, `delivered_at` — resolve lead via `leads.phone = to_number` | Recalculate score | yes |
| `message.failed` | Messaging Service | `message_id`, `twilio_sid`, `to_number`, `from_number`, `error_code`, `error_message` — resolve lead via `leads.phone = to_number` | — | yes |
| `inbound_message.received` | Messaging Service | `message_id`, `from_number`, `to_number`, `body`, `media_urls`, `received_at`, `message_type` — resolve lead via `leads.phone = from_number` | Recalculate score (lead responded → urgency up) | yes |
| `referral.converted` | Referral Service | `lead_id`, `location_id`, `referrer_id`, `referrer_type` | — | yes |
| `sequence.step_completed` | Nurturing Engine | `entity_id` (= `lead_id`), `entity_type: "lead"`, `sequence_id`, `step_id` | — | yes |
| `workflow.triggered` | Automation Engine | `entity_id` (= `lead_id` when `entity_type = "lead"`), `entity_type`, `workflow_id` | Handler skips if `entity_type != "lead"` | yes |

**Phone-based lookup note:** Messaging Service is domain-agnostic and never carries `lead_id`. Handlers resolve leads by normalizing the phone number and querying `leads.phone`. If no match is found, the handler logs a warning and skips — the phone may belong to an archived or never-imported lead.

**`lead.stage_timeout` note:** Pipeline Engine publishes `lead.stage_timeout` for non-archival timeouts. Lead Service intentionally does not subscribe — `lead.stage_changed` is sufficient for cache updates.

---

## 6. Key Behaviors

### 6.1 Deduplication

On every `POST /leads` (and `ad_lead.received` handler), Lead Service checks for matches against non-archived, non-merged-away leads:

- Exact E.164 phone match → flag as duplicate
- Exact email match (case-insensitive) → flag as duplicate
- `ad_platform_lead_id` match → treat as idempotent re-delivery, skip creation entirely (return existing lead)
- No match → create with `duplicate_status: none`

When flagged: lead is created (not blocked), `duplicate_status` set to `flagged`, `duplicate_of_id` points to the oldest matching lead. Both leads remain active until a coordinator resolves. `lead.created` is still published.

Data Import Service passes matched lead IDs directly to `PATCH /leads/:id` after its own 5-tier match logic — it does not go through the dedup creation path for records it has already matched.

### 6.2 Merge

`POST /leads/:id/merge` with `{ merge_lead_id, winning_stage }`:

1. Validate both leads exist, are not already merged, belong to accessible locations
2. If `winning_stage` differs from surviving lead's current stage → call Pipeline Engine `POST /pipeline/leads/:id/transition`. If Pipeline Engine returns an error or times out → return `503 { "error": "pipeline engine unreachable or rejected transition" }` immediately. No DB state is written before this call succeeds.
3. Copy all `lead_activities` from merged lead → surviving lead (preserving `occurred_at`)
4. Copy `lead_tags` from merged lead not already on surviving lead
5. Set `merged_lead.merged_into_id = surviving_lead.id`, `merged_lead.archived_at = now()`
6. Write `lead_merges` audit row (including `merged_lead_location_id`)
7. Publish `lead.merged`

Attribution: surviving lead's first-touch attribution is preserved unchanged. The merged-away lead remains queryable via `GET /leads/:id` for attribution reference.

### 6.3 Score Computation

`score-calculator.ts` is a pure function — takes the lead record + triggering event payload, returns a `smallint` 0–100. No I/O. Called synchronously inside the event worker on relevant events. Initial score at creation is `0`.

Stage time limits are defined as constants in `score-calculator.ts`:

| Stage | Time Limit |
|---|---|
| New Lead | 2 hours |
| Contacted | 5 days |
| Exam Completed | 7 days |
| Tx Presented | 14 days |
| Lost (re-engagement) | 30 days |
| Exam Scheduled | until `scheduled_at` |
| In Treatment / In Retention stages | no urgency limit |

Score factors:

| Factor | Effect |
|---|---|
| Stage time limit proximity | Days remaining < 20% of limit → urgency boost |
| Inbound message received | +weight (lead is engaged and responding) |
| Last inbound message age | No response in >3 days → urgency boost |
| Stage value weight | `tx_presented` > `exam_completed` > `exam_scheduled` > `contacted` > `new_lead` |
| `contact_status` | `sms_opted_out` or `email_invalid` → penalty; `fully_unreachable` → floor at 5 |

### 6.4 Search

`GET /leads?q=smith` — trigram similarity search across `first_name || ' ' || last_name`, `phone`, `email` using `pg_trgm` GIN indexes. Results ordered by similarity score descending, then `leads.score` descending as tiebreaker. Minimum similarity threshold: `0.2` (configurable via `SEARCH_SIMILARITY_THRESHOLD` env var).

### 6.5 Cursor Pagination

`GET /leads` uses opaque keyset cursor pagination. The cursor is a base64-encoded JSON blob containing `(last_seen_id, last_seen_sort_value)`. This supports correct pagination across all three sort modes:

- `sort=score` → cursor encodes `(id, score)`
- `sort=created_at` → cursor encodes `(id, created_at)`
- `sort=last_activity_at` → cursor encodes `(id, last_activity_at)`

The `id` tiebreaker guarantees stable ordering when two records share the same sort value. Page size default: `50`. Maximum: `200`. Query param: `?cursor=<opaque>`.

### 6.6 Contact Status Transitions

```
active ──────────────────────────────────────► sms_opted_out
  │                                                  │
  │ (email.bounced hard)              (email.bounced)│
  ▼                                                  ▼
email_invalid ──────────────────────────► fully_unreachable
```

`opt_out.removed` restores: `sms_opted_out` → `active`; `fully_unreachable` → `email_invalid`. Soft bounces do not change `contact_status`.

### 6.7 Phone Normalization

All phone numbers are normalized to E.164 format using `libphonenumber-js` before storage or lookup. Applied at:
- `POST /leads` route handler (body field `phone`)
- `PATCH /leads/:id` route handler (if `phone` is being updated)
- `ad_lead.received` event handler (`fields.phone_number`)
- Phone-based event handlers (opt-out, message events) — normalize before DB lookup

Normalization failure (unparseable number) returns `400 Bad Request` from HTTP routes. For event handlers, log a warning and skip.

---

## 7. Internal Structure

```
apps/crm/lead/
├── src/
│   ├── routes/
│   │   ├── health.ts
│   │   ├── leads.ts
│   │   ├── appointments.ts
│   │   ├── tags.ts
│   │   └── activities.ts
│   ├── services/
│   │   ├── lead-service.ts          # CRUD, dedup check, phone normalization
│   │   ├── merge-service.ts         # merge orchestration
│   │   ├── appointment-service.ts
│   │   └── tag-service.ts
│   ├── repositories/
│   │   ├── lead-repository.ts       # location scoping: WHERE location_id = ANY($locations)
│   │   ├── activity-repository.ts
│   │   ├── appointment-repository.ts
│   │   └── tag-repository.ts
│   ├── workers/
│   │   ├── event-worker.ts          # createEventBus() → bus.subscribe() × 13 → bus.start()
│   │   └── handlers/
│   │       ├── ad-lead-received.ts
│   │       ├── stage-changed.ts
│   │       ├── lead-archived.ts     # uses source_event_id = "internal:lead.archived:{lead_id}"
│   │       ├── lead-converted.ts    # writes timeline entry before state update
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
│   │   └── publisher.ts             # bus.publish() wrappers for all 5 published event types
│   ├── scoring/
│   │   └── score-calculator.ts      # pure function, no I/O
│   ├── middleware/
│   │   └── service-auth.ts          # SERVICE_AUTH_TOKEN preHandler for internal-only routes
│   ├── db.ts                        # Knex instance (instantiated directly with pg; no @ortho/db)
│   └── index.ts
├── migrations/
├── test/
│   ├── unit/
│   │   ├── score-calculator.test.ts
│   │   ├── dedup.test.ts
│   │   ├── merge-service.test.ts
│   │   ├── contact-status.test.ts
│   │   └── handlers/                # one file per event handler, mocked DB + MockDriver
│   └── integration/
│       ├── leads.test.ts
│       ├── appointments.test.ts
│       ├── tags.test.ts
│       ├── activities.test.ts
│       └── event-worker.test.ts     # real DB + RedisStreamsDriver
├── Dockerfile
├── package.json
└── tsconfig.json
```

**Key file responsibilities:**

- `index.ts` — creates Fastify app; registers `authPlugin` (IDENTITY_JWKS_URL, `allowedPaths: ["/health"]`); registers all route plugins; starts event bus worker; handles SIGTERM for graceful bus shutdown. Logger: `createLogger('crm-lead')`.
- `event-worker.ts` — calls `createEventBus()`, registers all 13 subscriptions, calls `bus.start()`. Started in `index.ts` alongside the Fastify server.
- `lead-repository.ts` — all list queries include `WHERE location_id = ANY($locations)` scoping. Empty array = no location filter applied.
- `service-auth.ts` — `preHandler` that validates `Authorization: Bearer <SERVICE_AUTH_TOKEN>` for internal routes (e.g. `DELETE /leads/:id/appointments/:appt_id`). This endpoint accepts service token auth only — no JWT required.
- `score-calculator.ts` — pure function — takes lead record + event payload, returns score integer. Easy to unit test in isolation.

---

## 8. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | Yes | HTTP server port (default: `3000`) |
| `LOG_LEVEL` | No | Pino log level (default: `info`) |
| `EVENT_BUS_DRIVER` | Yes | `"eventbridge"` (prod) or `"redis"` (local/test) |
| `EVENT_BRIDGE_BUS_NAME` | EventBridge only | EventBridge bus name |
| `SQS_QUEUE_URL` | EventBridge only | SQS FIFO queue URL |
| `AWS_REGION` | EventBridge only | AWS region (e.g. `us-east-1`) |
| `AWS_ACCESS_KEY_ID` | EventBridge only | AWS credentials |
| `AWS_SECRET_ACCESS_KEY` | EventBridge only | AWS credentials |
| `REDIS_URL` | Redis only | Redis connection URL |
| `EVENT_BUS_CONSUMER_GROUP` | Redis only | Consumer group name (e.g. `lead`) |
| `IDENTITY_JWKS_URL` | Yes | Identity Service JWKS endpoint |
| `PIPELINE_ENGINE_URL` | Yes | Pipeline Engine base URL for merge transitions |
| `AI_SERVICE_URL` | Yes | AI Service base URL for score commentary |
| `SEARCH_SIMILARITY_THRESHOLD` | No | Trigram similarity threshold for `?q=` search (default: `0.2`) |
| `SERVICE_AUTH_TOKEN` | Yes | Shared secret for internal service-to-service routes |

---

## 9. Error Handling

| Scenario | Response |
|---|---|
| `PATCH /leads/:id` with attribution field in request body | `400 Bad Request` — `{ "error": "attribution fields are immutable" }` |
| `POST /leads` or `PATCH /leads/:id` with unparseable phone number | `400 Bad Request` — `{ "error": "invalid phone number" }` |
| `GET /leads` with `phones[]` or `emails[]` exceeding 100 items | `400 Bad Request` — `{ "error": "bulk lookup limit exceeded" }` |
| `GET /leads` with `ids[]` exceeding 500 items | `400 Bad Request` — `{ "error": "bulk lookup limit exceeded" }` |
| `POST /leads/:id/merge` — Pipeline Engine timeout or error | `503 Service Unavailable` — `{ "error": "pipeline engine unreachable or rejected transition" }` — no DB state written |
| `GET /leads/:id/score-commentary` — AI Service unavailable | `503 Service Unavailable` — pass through AI Service error |
| `POST /tags` — name conflict for location (or global) | `409 Conflict` — `{ "error": "tag name already exists" }` |
| Event worker handler: unknown `lead_id` or unresolvable phone | Log warn + skip — do not dead-letter |
| Event worker handler: DB failure | Message re-delivered by transport (SQS visibility timeout / Redis retry). After max retries → DLQ + Datadog alert |
| `ad_lead.received` with existing `ad_platform_lead_id` | Skip creation silently — idempotent re-delivery |
| `DELETE /leads/:id/appointments/:appt_id` — missing `SERVICE_AUTH_TOKEN` | `401 Unauthorized` |

---

## 10. Dependencies

```jsonc
// apps/crm/lead/package.json (dependencies)
{
  "@ortho/auth-middleware": "file:../../../packages/@ortho/auth-middleware",
  "@ortho/event-bus":       "file:../../../packages/@ortho/event-bus",
  "@ortho/logger":          "file:../../../packages/@ortho/logger",
  "@ortho/types":           "file:../../../packages/@ortho/types",
  "@fastify/sensible":      "^6.0.0",
  "@sinclair/typebox":      "^0.34.0",
  "fastify":                "^5.0.0",
  "knex":                   "^3.0.0",
  "libphonenumber-js":      "^1.0.0",
  "pg":                     "^8.0.0"
}
```

`@ortho/interpolator`, `@platform/filter-engine`, BullMQ, and `node-cron` are NOT used by this service.

---

## 11. `@ortho/types` Extensions

The following types must be added to `packages/@ortho/types/src/events.ts` as part of this implementation:

**Lead Service published events:**
- `LeadCreatedEvent` / `LeadCreatedPayload`
- `LeadUpdatedEvent` / `LeadUpdatedPayload`
- `LeadMergedEvent` / `LeadMergedPayload`
- `LeadArchivedEvent` / `LeadArchivedPayload`
- `AppointmentUpdatedEvent` / `AppointmentUpdatedPayload`

**Subscribed event payload types** (published by other services, consumed by Lead Service worker):
- `LeadStageChangedPayload`
- `LeadConvertedPayload`
- `OptOutReceivedPayload`
- `OptOutRemovedPayload`
- `EmailBouncedPayload`
- `MessageDeliveredPayload`
- `MessageFailedPayload`
- `InboundMessageReceivedPayload`
- `ReferralConvertedPayload`
- `SequenceStepCompletedPayload`
- `WorkflowTriggeredPayload`

(`AdLeadReceivedPayload` / `AdLeadReceivedEvent` are already defined in `@ortho/types/src/events.ts`.)

---

## 12. Implementation Phasing

The service is implemented in three phases to limit Ralph's working set per iteration:

### Phase 1 — Core CRUD Routes

- `apps/crm/lead/` scaffold: `package.json`, `tsconfig.json`, `Dockerfile`
- `src/db.ts` — Knex instance
- `src/index.ts` — Fastify server, authPlugin registration, all route plugins
- Migrations: `leads`, `appointments`, `lead_activities`, `tags`, `lead_tags`, `lead_merges` tables + all indexes
- `src/repositories/`: `lead-repository.ts`, `appointment-repository.ts`, `tag-repository.ts`, `activity-repository.ts`
- `src/services/`: `lead-service.ts` (CRUD only, no dedup), `appointment-service.ts`, `tag-service.ts`
- `src/routes/`: `health.ts`, `leads.ts` (CRUD + list + search + bulk lookup + cursor pagination), `appointments.ts`, `tags.ts`, `activities.ts`
- `src/middleware/service-auth.ts`
- Unit tests for repositories and services (mocked DB)
- Integration tests for all route groups

### Phase 2 — Deduplication, Merge, Score Calculator

- `src/services/lead-service.ts` — add dedup check to `POST /leads`
- `src/services/merge-service.ts` — full merge orchestration (Pipeline Engine call, activity copy, tag merge, audit row, `lead.merged` publish)
- `src/scoring/score-calculator.ts` — pure function, all factors
- `GET /leads/duplicates` route
- `POST /leads/:id/merge` route
- `PATCH /leads/:id/duplicate-status` route
- `src/events/publisher.ts` — all 5 event publishers
- Unit tests: `dedup.test.ts`, `merge-service.test.ts`, `score-calculator.test.ts`, `contact-status.test.ts`

### Phase 3 — Event Worker + All 13 Handlers + `@ortho/types` Extensions

- `@ortho/types/src/events.ts` — add all new event types
- `src/workers/event-worker.ts` — `createEventBus()` wiring
- `src/workers/handlers/` — all 13 handler files
- Integration with `src/index.ts` — start event worker on server startup, stop on SIGTERM
- Integration tests: `event-worker.test.ts` (RedisStreamsDriver + real DB)
