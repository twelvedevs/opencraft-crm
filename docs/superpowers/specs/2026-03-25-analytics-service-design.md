# Analytics Service — Design Spec

**Date:** 2026-03-25
**Status:** Draft
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
  │   Event Handler Registry                          │
  │   (maps event_type → typed handler fn)            │
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
2. Each dequeued message is routed to a typed handler by `event_type`.
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
UNIQUE (date, location_id, channel)
```

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
campaign_name text
impressions   int            NOT NULL DEFAULT 0
clicks        int            NOT NULL DEFAULT 0
spend         numeric(12,2)  NOT NULL DEFAULT 0
UNIQUE (date, platform, campaign_id)
```

**`metrics_campaigns_daily`**
```sql
date         date   NOT NULL
campaign_id  text   NOT NULL
location_id  text   NOT NULL
sent         int    NOT NULL DEFAULT 0
delivered    int    NOT NULL DEFAULT 0
opened       int    NOT NULL DEFAULT 0
clicked      int    NOT NULL DEFAULT 0
UNIQUE (date, campaign_id)
```

**Rollup retention:** No expiry on rollup tables. Row count is bounded by `days × locations × dimensions` — negligible footprint compared to the raw event log.

---

## 4. Event Handlers

Nine typed handlers. Each follows the same contract: extract dimensions from the event payload → write one row to `analytics_events` → update the relevant rollup table — all in a single DB transaction.

| Event | Handler | Rollup Updated | Key Dimensions Extracted |
|---|---|---|---|
| `lead.created` | `LeadCreatedHandler` | `metrics_leads_daily` | `location_id`, `channel` |
| `lead.stage_changed` | `StageChangedHandler` | `metrics_pipeline_daily` | `location_id`, `pipeline`, `stage_to` |
| `lead.converted` | `LeadConvertedHandler` | `metrics_conversions_daily` | `location_id`, `channel` |
| `message.delivered` | `MessageDeliveredHandler` | `metrics_messages_daily` (delivered+1) | `location_id` |
| `message.failed` | `MessageFailedHandler` | `metrics_messages_daily` (failed+1) | `location_id` |
| `opt_out.received` | `OptOutHandler` | `metrics_messages_daily` (opt_outs+1) | `location_id` |
| `campaign.sent` | `CampaignSentHandler` | `metrics_campaigns_daily` | `campaign_id`, `location_id` |
| `referral.converted` | `ReferralConvertedHandler` | `metrics_conversions_daily` (channel=`referral`) | `location_id` |
| `ad_spend.synced` | `AdSpendSyncedHandler` | `metrics_ad_spend_daily` | `platform`, `location_id`, `campaign_id` |

**`ad_spend.synced` specifics:** Integration Hub publishes one event per sync cycle containing an array of campaign spend records for a given platform and date. `AdSpendSyncedHandler` upserts each record — `ON CONFLICT (date, platform, campaign_id) DO UPDATE` overwrites the full row. Re-syncs are idempotent.

**Email engagement (future):** `email.opened` and `email.clicked` handler stubs exist in the registry. They will populate `metrics_campaigns_daily.opened` and `.clicked` once the Email Service is confirmed to publish these events with `campaign_id` and `location_id` in the payload. This is a cross-service dependency that requires an amendment to the Email Service spec.

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

All endpoints require a valid Identity Service JWT. Location-scoped access control is enforced by the Reporting Service before calling Analytics — the Analytics Service itself does not enforce location restrictions (it is domain-agnostic and unaware of which locations a caller may access).

---

## 6. Operational Concerns

### 6.1 Idempotency

SQS delivers at-least-once. Duplicate delivery is handled via the `event_id` field (sourced from the EventBridge message ID):

```sql
INSERT INTO analytics_events (...) VALUES (...)
ON CONFLICT (event_id) DO NOTHING
```

If the raw insert is skipped (duplicate), the rollup update is also skipped within the same transaction. No double-counting.

### 6.2 SQS Configuration

- **Visibility timeout:** 30s — handler + DB write completes in <5s; this provides headroom for slow queries
- **Max receive count:** 3 retries before DLQ
- **DLQ alert:** Any message landing in the DLQ triggers a Datadog alert. A DLQ hit means attribution data was permanently lost — this is a critical signal.

### 6.3 Partition Maintenance

`analytics_events` is partitioned by month on `occurred_at`. A BullMQ repeatable job runs on the 1st of each month:
1. Creates the partition for the next calendar month
2. Drops the partition from 25 months ago (retaining exactly 24 months of data)

Dropping an old partition is a metadata operation — no row-by-row deletion, no table lock on the live table.

### 6.4 No `@platform/filter-engine` Dependency

Analytics does not evaluate filter condition trees. The generic DSL performs simple JSONB equality and IN filtering. There is no dependency on `@platform/filter-engine`.

---

## 7. Cross-Service Dependencies

| Dependency | Type | Notes |
|---|---|---|
| Integration Hub | EventBridge (`ad_spend.synced`) | Must include `platform`, `location_id`, `campaign_id`, `date`, `spend`, `impressions`, `clicks` per campaign record in payload |
| Email Service | EventBridge (`email.opened`, `email.clicked`) | Must include `campaign_id`, `location_id` in payload. **Not yet in arch doc event table — requires amendment.** |
| Reporting Service | REST consumer (`GET /analytics/metrics/*`, `POST /analytics/query`) | All Ortho-specific metric computation (cost per case, ROAS, coordinator metrics) lives in Reporting Service |
| Identity Service | JWT validation | All API endpoints require a valid JWT |

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
│   │   ├── sqs-consumer.ts   # polls SQS, routes to handler registry
│   │   ├── handler-registry.ts
│   │   └── query-builder.ts  # DSL → SQL translation
│   ├── handlers/
│   │   ├── lead-created.ts
│   │   ├── stage-changed.ts
│   │   ├── lead-converted.ts
│   │   ├── message-delivered.ts
│   │   ├── message-failed.ts
│   │   ├── opt-out-received.ts
│   │   ├── campaign-sent.ts
│   │   ├── referral-converted.ts
│   │   └── ad-spend-synced.ts
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
