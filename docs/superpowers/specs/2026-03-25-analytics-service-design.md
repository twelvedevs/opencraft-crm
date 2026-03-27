# Analytics Service — Design Spec

**Date:** 2026-03-25
**Status:** Approved
**Scope:** Platform-layer Analytics Service — event ingestion pipeline, metric aggregation, time-series storage, named metric API, generic query DSL

---

## 1. Overview

The Analytics Service is a **platform-layer service** (`apps/platform/analytics`) that ingests domain events from AWS EventBridge, maintains pre-aggregated metric rollup tables, and exposes a query API consumed by the Reporting Service. It is fully generic — it has no knowledge of Ortho CRM concepts such as leads, pipeline stages, or coordinators.

**Core responsibilities:**
- Ingest domain events via SQS-buffered EventBridge subscription
- Write immutable raw event log for auditability and ad-hoc queries
- Maintain pre-aggregated daily rollup tables updated atomically at ingest time
- Expose named metric endpoint families with a consistent filter/period interface
- Expose a generic query DSL against the raw event log for ad-hoc and research use cases

**Out of scope:**
- Ortho-specific metric computation (cost per case, ROAS, funnel rates) — owned by the Reporting Service
- Dashboard UI — owned by the Reporting Service; Analytics ships no `@platform/analytics-ui` component
- Ad spend polling — owned by the Integration Hub, which publishes `ad_spend.synced` events

---

## 2. Architecture

```
AWS EventBridge events
        │
        ▼ (SQS subscription — durable buffer, DLQ on failure)
  ┌──────────────────────────────────────────────────┐
  │            Analytics Service                      │
  │   apps/platform/analytics                         │
  │                                                   │
  │   SQS Consumer                                    │
  │        │                                          │
  │   Event Router                                    │
  │   (switch on event_type → typed handler fn)       │
  │        │                                          │
  │   ┌────┴──────────────────────────┐               │
  │   Write raw event row             Update rollup   │
  │   → analytics_events              → daily_metrics │
  │   └───────────────────────────────┘               │
  │          (single DB transaction)                   │
  │                                                   │
  │   REST API (Fastify)                              │
  │   GET  /analytics/metrics/{family}                │
  │   POST /analytics/query                           │
  └──────────────────────────────────────────────────┘
              │
        Reporting Service
```

**Ingest flow:**
1. EventBridge delivers subscribed events to an SQS queue. The Analytics service polls SQS — the same durable pattern used by the Automation Engine. Events are not dropped during deploys or restarts; the SQS buffer absorbs backpressure.
2. Each dequeued message is routed to a typed handler by a plain `switch` on `event_type` in `event-router.ts`. There is no registration map or dynamic dispatch system — each handler is called directly.
3. The handler extracts dimensions and writes atomically: one row to `analytics_events` (immutable raw log) + an `INSERT ... ON CONFLICT DO UPDATE` increment on the relevant daily rollup table.
4. Unknown event types are logged at `debug` level, acknowledged from SQS, and dropped — no error, no retry.

**No BullMQ for ingest.** The write path is a straightforward DB transaction — no fan-out, no per-action retry chain. BullMQ is only used for the scheduled partition maintenance job (see Section 6).

---

## 3. Storage Schema

### 3.1 Raw Event Log — `analytics_events`

Immutable append-only log. Powers the generic query DSL and enables rollup re-derivation if a bug corrupts counters.

```sql
id            uuid          PRIMARY KEY DEFAULT gen_random_uuid()
event_id      text          UNIQUE NOT NULL   -- EventBridge message ID, used for dedup
event_type    text          NOT NULL          -- 'lead.created', 'ad_spend.synced', etc.
source        text          NOT NULL          -- originating service: 'crm_lead', 'platform_messaging', etc.
entity_type   text                            -- 'lead', 'campaign', 'sequence_step', etc.
entity_id     text
dimensions    jsonb         NOT NULL DEFAULT '{}'  -- extracted key-values for filtering
properties    jsonb         NOT NULL DEFAULT '{}'  -- full event payload snapshot
occurred_at   timestamptz   NOT NULL
ingested_at   timestamptz   NOT NULL DEFAULT now()
```

**Indexes:**
- `(event_type, occurred_at)` — handler dedup + DSL queries
- GIN on `dimensions` — JSONB filtering in DSL queries

**Partitioning:** Partitioned by month on `occurred_at` (`PARTITION BY RANGE`). A BullMQ repeatable job runs on the 1st of each month to create the next partition and drop partitions older than 24 months, matching the PRD's 24-month lookback requirement.

### 3.2 Rollup Tables

Six named rollup tables. Each uses `INSERT ... ON CONFLICT DO UPDATE` for atomic increments.

**`metrics_leads_daily`**
```sql
date         date   NOT NULL
location_id  text   NOT NULL
channel      text   NOT NULL   -- google_ads, facebook_ads, referral, walk_in, organic, etc.
count        int    NOT NULL DEFAULT 0
archived     int    NOT NULL DEFAULT 0   -- leads archived on this date (lead.archived events)
UNIQUE (date, location_id, channel)
```

**Note on `lead.archived` and channel dimension:** `lead.archived` payload carries only `lead_id` and `location_id` — no channel. `LeadArchivedHandler` uses `channel = 'unknown'` as the channel dimension for the rollup row (since it cannot look up the original channel without a cross-service call). Reporting Service should query archived totals by location only, not by channel breakdown.

**`metrics_pipeline_daily`**
```sql
date         date   NOT NULL
location_id  text   NOT NULL
pipeline     text   NOT NULL   -- new_patient, in_treatment, in_retention
stage        text   NOT NULL
entries      int    NOT NULL DEFAULT 0   -- leads entering this stage on this date
UNIQUE (date, location_id, pipeline, stage)
```

**`metrics_conversions_daily`**
```sql
date         date   NOT NULL
location_id  text   NOT NULL
channel      text   NOT NULL
count        int    NOT NULL DEFAULT 0
UNIQUE (date, location_id, channel)
```

**`metrics_messages_daily`**
```sql
date         date   NOT NULL
location_id  text   NOT NULL
delivered    int    NOT NULL DEFAULT 0
failed       int    NOT NULL DEFAULT 0
opt_outs     int    NOT NULL DEFAULT 0
UNIQUE (date, location_id)
```

**`metrics_ad_spend_daily`**
```sql
date          date           NOT NULL
platform      text           NOT NULL   -- google_ads, facebook_ads
location_id   text           NOT NULL
campaign_id   text           NOT NULL
campaign_name text                      -- display hint only; see note below
impressions   int            NOT NULL DEFAULT 0
clicks        int            NOT NULL DEFAULT 0
spend         numeric(12,2)  NOT NULL DEFAULT 0
UNIQUE (date, platform, location_id, campaign_id)
```

**`campaign_name` is a display hint.** The upsert overwrites the full row on each sync, so if a campaign is renamed in the ad platform, older rows retain the old name and newer rows have the new name. Reporting Service queries must always group by `campaign_id` — never by `campaign_name` — to produce correct aggregations.

**`metrics_campaigns_daily`**
```sql
date         date   NOT NULL
campaign_id  text   NOT NULL
location_id  text   NOT NULL
sent         int    NOT NULL DEFAULT 0
delivered    int    NOT NULL DEFAULT 0
opened       int    NOT NULL DEFAULT 0
clicked      int    NOT NULL DEFAULT 0
UNIQUE (date, campaign_id, location_id)
```

**`metrics_referrals_daily`**
```sql
date         date   NOT NULL
location_id  text   NOT NULL
count        int    NOT NULL DEFAULT 0   -- referral.converted events
UNIQUE (date, location_id)
```

**`metrics_coordinators_daily`**
```sql
date                  date   NOT NULL
location_id           text   NOT NULL
coordinator_id        text   NOT NULL   -- triggered_by from lead.stage_changed
response_time_sum     int    NOT NULL DEFAULT 0   -- sum of response_time_seconds (when present)
response_time_count   int    NOT NULL DEFAULT 0   -- count of events where response_time_seconds is non-null
time_in_stage_sum     int    NOT NULL DEFAULT 0   -- sum of time_in_stage_seconds
time_in_stage_count   int    NOT NULL DEFAULT 0   -- count of events where triggered_by is non-null
UNIQUE (date, location_id, coordinator_id)
```

**Incremental mean computation for coordinator metrics:** Rollup stores running sums + counts (not pre-computed averages). Reporting Service computes `response_time_sum / response_time_count` and `time_in_stage_sum / time_in_stage_count` at query time — this pattern supports correct multi-period aggregation without floating-point precision loss.

**Rollup retention:** No expiry on rollup tables. Row count is bounded by `days × locations × dimensions` — negligible footprint compared to the raw event log.

---

## 4. Event Handlers

Thirteen typed handlers. Each follows the same contract: extract dimensions from the event payload → write one row to `analytics_events` → update the relevant rollup table — all in a single DB transaction.

All events follow the standard envelope defined in `@ortho/types`. The dimension fields extracted per event are:

- `lead.created` payload must carry: `location_id`, `channel` (first-touch attribution channel, e.g. `google_ads`, `facebook_ads`, `referral`, `walk_in`)
- `lead.stage_changed` payload must carry: `location_id`, `pipeline` (e.g. `new_patient`), `stage_to` (the stage being entered, e.g. `exam_scheduled`)
- `lead.converted` payload must carry: `location_id`, `channel` (first-touch attribution channel from the lead record)

| Event | Handler | Rollup Updated | Key Dimensions Extracted |
|---|---|---|---|
| `lead.created` | `LeadCreatedHandler` | `metrics_leads_daily` | `location_id`, `channel` |
| `lead.stage_changed` | `StageChangedHandler` | `metrics_pipeline_daily` + `metrics_coordinators_daily` | `location_id`, `pipeline`, `stage_to`, `triggered_by?`, `response_time_seconds?`, `time_in_stage_seconds` |
| `lead.archived` | `LeadArchivedHandler` | `metrics_leads_daily` (archived+1, separate column — see note) | `location_id` |
| `lead.converted` | `LeadConvertedHandler` | `metrics_conversions_daily` | `location_id`, `channel` (from attribution) |
| `message.delivered` | `MessageDeliveredHandler` | `metrics_messages_daily` (delivered+1) | `location_id` |
| `message.failed` | `MessageFailedHandler` | `metrics_messages_daily` (failed+1) | `location_id` |
| `opt_out.received` | `OptOutHandler` | `metrics_messages_daily` (opt_outs+1) | `location_id` |
| `campaign.sent` | `CampaignSentHandler` | `metrics_campaigns_daily` | `campaign_id`, `location_id` |
| `email.opened` | `EmailOpenedHandler` | `metrics_campaigns_daily` (opened+1) | `campaign_id`, `location_id` |
| `email.clicked` | `EmailClickedHandler` | `metrics_campaigns_daily` (clicked+1) | `campaign_id`, `location_id` |
| `referral.converted` | `ReferralConvertedHandler` | `metrics_referrals_daily` + `metrics_conversions_daily` (channel=`referral`) | `location_id` |
| `ad_spend.synced` | `AdSpendSyncedHandler` | `metrics_ad_spend_daily` | `platform`, `location_id`, `campaign_id` |

**`ad_spend.synced` specifics:** Integration Hub publishes one event per `(platform, location_id, date)` combination. Campaigns with no location mapping configured are not published. The payload structure is:

```json
{
  "platform": "google_ads",
  "location_id": "loc_123",
  "synced_date": "2026-03-25",
  "records": [
    {
      "campaign_id": "camp_abc",
      "campaign_name": "Spring Braces Promo",
      "impressions": 4200,
      "clicks": 310,
      "spend": 185.40
    }
  ]
}
```

`AdSpendSyncedHandler` reads `platform`, `location_id`, and `synced_date` from the top-level envelope and iterates `records`. Each record is upserted into `metrics_ad_spend_daily` — `ON CONFLICT (date, platform, location_id, campaign_id) DO UPDATE` overwrites the full row. Re-syncs are idempotent regardless of `event_id`.

**Idempotency for `AdSpendSyncedHandler` differs from counter-increment handlers.** For all other handlers, the raw `analytics_events` insert uses `ON CONFLICT (event_id) DO NOTHING`, and if the insert is skipped the rollup update is also skipped (no double-count). For `AdSpendSyncedHandler`, this rule is relaxed: the rollup upsert always executes even if the raw `analytics_events` row already exists. This allows Integration Hub to re-publish a corrected spend figure using the same `event_id` without the correction being silently ignored. The `analytics_events` row records the first delivery only; the rollup row always reflects the latest synced figures.

**`StageChangedHandler` — coordinator rollup logic:** On each `lead.stage_changed` event, the handler also writes to `metrics_coordinators_daily` when `triggered_by` is non-null (i.e., a human coordinator performed the transition). `time_in_stage_sum` and `time_in_stage_count` are always incremented (for all events with `triggered_by`). `response_time_sum` and `response_time_count` are incremented only when `response_time_seconds` is present in the payload (i.e., the transition was into the `contacted` stage). Events without `triggered_by` (timeout-driven, system-initiated) do not write to `metrics_coordinators_daily`.

**Email engagement:** `email.opened` and `email.clicked` handlers are active. Email Service spec has been amended to publish both events with `campaign_id`, `location_id`, `entity_type`, and `entity_id` in the payload. Handlers increment `metrics_campaigns_daily.opened` and `.clicked` respectively.

**Unknown event types:** Logged at `debug` level, acknowledged from SQS (no retry), not written to `analytics_events`.

---

## 5. API

### 5.1 Shared Query Parameters

All named metric endpoints share the same filter + period interface:

| Parameter | Type | Description |
|---|---|---|
| `period` | string | `YYYY-MM` for a calendar month, or `YYYY-MM-DD/YYYY-MM-DD` for a custom range |
| `granularity` | string | `daily` \| `monthly` \| `total` (default: `daily`) |
| `location_id` | string[] | Filter to one or more locations. Omit for all locations. |

All endpoints return: `{ period, granularity, data: [...rows] }`

### 5.2 Named Metric Endpoints

**`GET /analytics/metrics/leads`**
Returns lead counts by channel and location.
Additional filter: `channel` (comma-separated list).

**`GET /analytics/metrics/pipeline`**
Returns stage entry counts by pipeline, stage, and location.
Additional filters: `pipeline` (new_patient | in_treatment | in_retention), `stage`.

**`GET /analytics/metrics/conversions`**
Returns conversion counts by channel and location.
Additional filter: `channel`.

**`GET /analytics/metrics/messages`**
Returns delivered, failed, and opt-out counts by location.

**`GET /analytics/metrics/ad-spend`**
Returns spend, impressions, and clicks by platform, campaign, and location.
Additional filters: `platform` (google_ads | facebook_ads), `campaign_id`.

**`GET /analytics/metrics/campaigns`**
Returns sent, delivered, opened, and clicked counts by campaign and location.
Additional filter: `campaign_id`.

**`GET /analytics/metrics/referrals`**
Returns referral conversion counts by location.
Source: `metrics_referrals_daily`.

**`GET /analytics/metrics/coordinators`**
Returns coordinator activity metrics by location and coordinator.
Additional filter: `coordinator_id`.
Response rows include: `coordinator_id`, `response_time_sum`, `response_time_count`, `time_in_stage_sum`, `time_in_stage_count` — Reporting Service computes means at query time.
Source: `metrics_coordinators_daily`.

### 5.3 Generic Query DSL

**`POST /analytics/query`**

Queries the raw `analytics_events` table directly. Intended for ad-hoc and research use cases where the named endpoints do not cover the required dimension combination.

Request body:
```json
{
  "event_type": "lead.created",
  "aggregate": "count",
  "aggregate_field": null,
  "filters": {
    "dimensions.channel": ["google_ads", "facebook_ads"]
  },
  "group_by": ["dimensions.location_id", "dimensions.channel"],
  "period": {
    "from": "2026-01-01",
    "to": "2026-03-31"
  },
  "granularity": "monthly"
}
```

- `event_type` — required; queries are scoped to a single event type
- `aggregate` — `count` | `sum` | `avg`
- `aggregate_field` — dot-notation path into `dimensions` or `properties` JSONB; required for `sum` and `avg`, ignored for `count`
- `filters` — equality or IN matching on JSONB fields using dot notation; all conditions ANDed
- `group_by` — optional array of dot-notation fields; omit for a single aggregate value
- `granularity` — `daily` | `monthly` | `total` (default: `total`)
- `period` — required; ISO date range

Response: `{ rows: [...], total: N, truncated: boolean }`
- Capped at 10,000 rows. If the result set exceeds this, `truncated: true` is returned with the first 10,000 rows.

### 5.4 Auth

All endpoints support two auth methods:

**JWT (standard):** Bearer token issued by Identity Service. `@ortho/auth-middleware` verifies the JWT signature against the Identity Service JWKS and rejects expired tokens.

**API key (service-to-service):** When the `Authorization` header value starts with `ak_`, a **dedicated pre-middleware Fastify plugin** (`src/plugins/api-key-auth.ts`) intercepts the request before `@ortho/auth-middleware`. This plugin validates the key via `POST /identity/api-keys/validate` (VPC-only endpoint), caches the result by `SHA256(key)` for 60 seconds, and injects synthetic `X-User-Role` + `X-Api-Key-Permissions` headers so that downstream middleware sees a consistent auth context. **Do NOT modify `@ortho/auth-middleware`** — this plugin is Analytics Service-specific and registered only in this service. The Reporting Service authenticates to Analytics using `ANALYTICS_API_KEY` (an `ak_`-prefixed Identity Service API key).

Location-scoped access control is enforced by the Reporting Service before calling Analytics — the Analytics Service itself does not enforce location restrictions (it is domain-agnostic and unaware of which locations a caller may access).

---

## 6. Operational Concerns

### 6.1 Idempotency

SQS delivers at-least-once. Duplicate delivery is handled via the `event_id` field (sourced from the EventBridge message ID):

```sql
INSERT INTO analytics_events (...) VALUES (...)
ON CONFLICT (event_id) DO NOTHING
```

For all counter-increment handlers (`lead.created`, `lead.stage_changed`, `lead.archived`, `lead.converted`, `message.delivered`, `message.failed`, `opt_out.received`, `campaign.sent`, `email.opened`, `email.clicked`, `referral.converted`): if the raw insert is skipped (duplicate), the rollup increment is also skipped in the same transaction — no double-counting.

**Exception — `AdSpendSyncedHandler`:** The rollup upsert always executes regardless of whether the raw insert was skipped. See Section 4 for the rationale.

### 6.2 SQS Configuration

- **Visibility timeout:** 30s — handler + DB write completes in <5s; this provides headroom for slow queries
- **Max receive count:** 3 retries before DLQ
- **DLQ alert:** Any message landing in the DLQ triggers a Datadog alert. A DLQ hit means attribution data was permanently lost — this is a critical signal.

### 6.3 Partition Maintenance

`analytics_events` is partitioned by month on `occurred_at`. The table is created with a **default partition** (`analytics_events_default`) to catch any rows that arrive before the monthly partition is pre-created — this prevents insert failures if the maintenance job fires late. A BullMQ repeatable job runs at 00:01 on the 1st of each month:
1. Creates the named partition for the next calendar month
2. Moves any rows from the default partition that fall within the newly created month range
3. Drops the partition from 25 months ago (retaining exactly 24 months of data)

Example: when the job runs on 2026-04-01, it creates the `2026-05` partition and drops the `2024-03` partition. This retains 24 complete prior months (2024-04 through 2026-03) plus the active current-month partition (2026-04) that is still being written to.

Dropping an old partition is a metadata operation — no row-by-row deletion, no table lock on the live table.

### 6.4 No `@platform/filter-engine` Dependency

Analytics does not evaluate filter condition trees. The generic DSL performs simple JSONB equality and IN filtering. There is no dependency on `@platform/filter-engine`.

---

## 7. Cross-Service Dependencies

| Dependency | Type | Notes |
|---|---|---|
| Integration Hub | EventBridge (`ad_spend.synced`) | Payload: `platform`, `location_id`, `synced_date` at top level; `records[]` with `campaign_id`, `campaign_name`, `impressions`, `clicks`, `spend` per entry |
| Pipeline Engine | EventBridge (`lead.stage_changed`, `lead.converted`) | `lead.stage_changed` must include `location_id`, `pipeline`, `stage_to`. `lead.converted` must include `location_id`, `channel`. **Both payload shapes must be confirmed in Pipeline Engine spec — requires amendment.** |
| Messaging Service | EventBridge (`message.delivered`, `message.failed`, `opt_out.received`) | All three events must include `location_id` in payload. Currently unspecified in Messaging Service spec. **Requires amendment to Messaging Service spec.** |
| Campaign Service | EventBridge (`campaign.sent`) | Payload must include `campaign_id`, `location_id`. **Required fields not yet defined in arch doc event table — requires amendment.** |
| Email Service | EventBridge (`email.opened`, `email.clicked`) | Payload must include `campaign_id`, `location_id`. **Not yet in arch doc event table — requires amendment.** |
| Lead Service | EventBridge (`lead.created`) | Payload must include `location_id` and `channel` (first-touch attribution channel, e.g. `google_ads`). **`channel` field must be confirmed in Lead Service event schema.** |
| Reporting Service | REST consumer (`GET /analytics/metrics/*`, `POST /analytics/query`) | All Ortho-specific metric computation (cost per case, ROAS, coordinator metrics) lives in Reporting Service |
| Identity Service | JWT validation | All API endpoints require JWT with valid signature and non-expired claims |

---

## 8. File Structure

```
apps/platform/analytics/
├── src/
│   ├── routes/
│   │   ├── metrics/
│   │   │   ├── leads.ts
│   │   │   ├── pipeline.ts
│   │   │   ├── conversions.ts
│   │   │   ├── messages.ts
│   │   │   ├── ad-spend.ts
│   │   │   └── campaigns.ts
│   │   └── query.ts          # generic DSL endpoint
│   ├── services/
│   │   ├── sqs-consumer.ts   # polls SQS, calls event-router
│   │   ├── event-router.ts   # switch on event_type → typed handler fn
│   │   └── query-builder.ts  # DSL → SQL translation
│   ├── handlers/
│   │   ├── lead-created.ts
│   │   ├── stage-changed.ts
│   │   ├── lead-archived.ts
│   │   ├── lead-converted.ts
│   │   ├── message-delivered.ts
│   │   ├── message-failed.ts
│   │   ├── opt-out-received.ts
│   │   ├── campaign-sent.ts
│   │   ├── email-opened.ts
│   │   ├── email-clicked.ts
│   │   ├── referral-converted.ts
│   │   └── ad-spend-synced.ts
│   ├── plugins/
│   │   └── api-key-auth.ts   # pre-middleware ak_-prefixed key validation
│   ├── repositories/
│   │   ├── events.ts         # analytics_events insert + dedup
│   │   └── rollups.ts        # per-rollup-table upsert helpers
│   ├── jobs/
│   │   └── partition-maintenance.ts
│   └── index.ts
├── migrations/
├── test/
├── Dockerfile
├── package.json
└── tsconfig.json
```
