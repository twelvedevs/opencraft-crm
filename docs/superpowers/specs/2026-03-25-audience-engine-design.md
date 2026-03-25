# Audience Engine — Design Spec

**Date:** 2026-03-25
**Status:** Draft
**Scope:** Platform-layer Audience Engine — named segment registry, batch evaluation with caller-supplied entity data, audience snapshots, single-entity membership checks, shared `@platform/filter-engine` package, `@platform/audience-ui` React component.

---

## 1. Overview

The Audience Engine is a **platform-layer service** (`apps/platform/audience`) that stores named segment definitions, evaluates filter criteria against caller-supplied entity data, and produces audience snapshots for campaign sends. It is fully generic — it has no knowledge of Ortho CRM concepts such as leads, pipelines, or stages.

**Core responsibilities:**
- Store versioned named segment definitions (filter DSL)
- Evaluate segments against caller-submitted entity data (batched) and accumulate audience snapshots
- Support inline one-off evaluation without storing a segment definition
- Answer single-entity membership checks synchronously (for Automation Engine and product services)
- Ship `@platform/audience-ui` React component for staff to build and manage segments
- Export `@platform/filter-engine` — a shared pure-function filter evaluator used by both the Audience Engine and the Automation Engine

**Out of scope:**
- Fetching entity data from product services (caller always provides entity data)
- Real-time audience updates or change subscriptions
- Contact detail storage (entity IDs only — contact details stay in Lead Service)
- Audience send orchestration (Campaign Service drives the send loop)

---

## 2. Architecture

```
Campaign Service / Automation Engine / Product Services
           │
           ├── POST /audiences/segments               (create/update named segment)
           ├── POST /audiences/segments/:id/evaluate  (batch evaluate)
           ├── POST /audiences/evaluate               (inline one-off)
           ├── GET  /audiences/snapshots/:id          (retrieve snapshot members)
           └── POST /audiences/segments/:id/check     (single entity membership)
                        │
           ┌────────────────────────────────────────┐
           │          Audience Engine               │
           │   apps/platform/audience               │
           │                                        │
           │  REST API                              │
           │    → Segment Repository (30s cache)    │
           │    → Filter Evaluator                  │ ← @platform/filter-engine
           │    → Snapshot Manager                  │
           │    → Snapshot Cleanup Worker (BullMQ)  │
           └────────────────────────────────────────┘
                        │
              PostgreSQL  platform_audience  schema
              Redis       BullMQ (snapshot cleanup only)
```

**Data flow — campaign send:**
1. Campaign Service creates or references a named segment
2. Campaign Service fetches candidate entities from Lead Service (applying CRM-specific pre-filters)
3. Campaign Service enriches each entity record with fields needed for evaluation (e.g. `last_contact_at`, `opted_out`)
4. Campaign Service submits entity data in batches to `POST /audiences/segments/:id/evaluate` with a caller-generated `snapshot_id`
5. On final batch (`done: true`), engine seals the snapshot (status → `ready`)
6. Campaign Service calls `GET /audiences/snapshots/:snapshot_id` to retrieve entity IDs and drive the send loop

**Data flow — membership check:**
- Automation Engine or product service calls `POST /audiences/segments/:id/check` with a single entity record
- Engine loads segment's active filter from cache, evaluates in-memory, returns `{ matches: bool }`
- No snapshot created, no DB write on the hot path

**No EventBridge integration.** The Audience Engine is purely synchronous REST — no event subscriptions, no BullMQ action workers, no async side effects beyond snapshot cleanup.

**Golden rule compliance:** The engine never calls product-layer APIs. All entity data is pushed by the caller. The engine is a filter runtime and snapshot store — it has no knowledge of what field values like `"new_patient"` or `"contacted"` mean.

---

## 3. Filter DSL

Segment filters are stored and evaluated as a generic JSON condition tree. The same grammar is used by the Automation Engine (via the shared `@platform/filter-engine` package). The Audience Engine extends the base operator set with temporal operators.

### 3.1 Filter Node Structure

```json
{
  "op": "AND",
  "conditions": [
    { "field": "pipeline",        "op": "eq",              "value": "new_patient" },
    { "field": "stage",           "op": "in",              "value": ["contacted", "exam_scheduled"] },
    { "field": "location_id",     "op": "in",              "value": ["loc-1", "loc-2"] },
    { "field": "last_contact_at", "op": "not_within_last", "value": { "amount": 5, "unit": "days" } },
    { "field": "opted_out",       "op": "eq",              "value": false },
    { "field": "custom_tags",     "op": "contains",        "value": "vip" }
  ]
}
```

### 3.2 Base Operators (shared with Automation Engine)

| Operator | Description |
|---|---|
| `eq` / `neq` | Equality / inequality |
| `in` / `not_in` | Value in array |
| `gt` / `gte` / `lt` / `lte` | Numeric comparison |
| `contains` | Array or string contains value |
| `exists` / `not_exists` | Field presence check |
| `AND` / `OR` | Boolean grouping — `"op": "AND"/"OR", "conditions": [...]` (array, nestable) |
| `NOT` | Boolean negation — `"op": "NOT", "condition": { ... }` (singular child, not array) |

Example `NOT` node:
```json
{ "op": "NOT", "condition": { "field": "opted_out", "op": "eq", "value": true } }
```

### 3.3 Extended Temporal Operators (Audience Engine only)

| Operator | Description | Value shape |
|---|---|---|
| `within_last` | Field (timestamp) is within last N days/hours from `now` | `{ "amount": 5, "unit": "days" }` |
| `not_within_last` | Field (timestamp) is older than N days/hours from `now` | `{ "amount": 5, "unit": "days" }` |
| `before` | Field (timestamp) is before a fixed date | ISO 8601 string |
| `after` | Field (timestamp) is after a fixed date | ISO 8601 string |
| `date_range` | Field (timestamp) is within a start/end range | `{ "start": "...", "end": "..." }` |

Temporal operators require `EvalContext` (`{ now: Date }`) to be passed to the evaluator. The Automation Engine passes no context (it never uses temporal operators — passing undefined context while using only base operators is valid).

**No aggregate operators.** "No contact in X days" is handled by the caller enriching each entity with a `last_contact_at` field before submission. Cross-service data joins are the product layer's responsibility.

### 3.4 Field Resolution

Fields are resolved by dot-notation path against the entity object. `"field": "address.city"` resolves to `entity.address.city`. A missing field evaluates as `undefined` — `not_exists` passes, all other operators return `false`. No field interpolation (unlike the Automation Engine, entity data is the only context here).

---

## 4. `@platform/filter-engine` Package

A pure-function TypeScript package with zero runtime dependencies. Both the Automation Engine and the Audience Engine import from it.

```
packages/@platform/filter-engine/
├── src/
│   ├── evaluate.ts         # evaluate(filter, entity, context?) → boolean
│   ├── operators/
│   │   ├── base.ts         # eq, neq, in, not_in, gt, gte, lt, lte, contains, exists, not_exists
│   │   └── temporal.ts     # within_last, not_within_last, before, after, date_range
│   ├── types.ts            # FilterNode, EvalContext, Operator type definitions
│   └── index.ts
├── test/
└── package.json
```

**API:**
```typescript
evaluate(
  filter: FilterNode,
  entity: Record<string, unknown>,
  context?: EvalContext          // { now: Date } — required only for temporal operators
): boolean
```

**Automation Engine migration:** The existing `condition-evaluator.ts` in `apps/platform/automation` is replaced with a thin wrapper around `@platform/filter-engine`. The base operators and field resolution behavior are identical — no behavior change. When the Automation Engine wraps `@platform/filter-engine`, the event object (post-schema-validation) is passed as the `entity` argument. Template string interpolation (`{{event_id}}-sms`) is performed by the field interpolator separately for `action_tree` param binding only — not for condition evaluation. The filter engine receives already-resolved field values when used from the Automation Engine context. The Automation Engine spec (Section 6 action types) requires a minor amendment noting this call chain.

---

## 5. API

All endpoints require an Identity Service JWT. Segment creation and activation require Marketing Manager role. Evaluate and check endpoints are callable by any authenticated service.

### 5.1 Segment Management

**`POST /audiences/segments`** — Create a new named segment (draft).

Request:
```json
{
  "name": "Contacted — No Response 5 Days",
  "filter": { "op": "AND", "conditions": [...] }
}
```
Response `201`:
```json
{ "segment_id": "uuid", "version": 1, "status": "draft" }
```

Segment `name` is not required to be unique — segments are identified by UUID. Names are labels for human readability only.

Error responses: `400` if `filter` is structurally invalid (unknown operator, missing required fields, `NOT` node missing `condition`, `AND`/`OR` node missing `conditions` array).

---

**`PUT /audiences/segments/:id`** — Save a new draft version. Increments `current_version`. Does not affect `active_version`.

Request: `{ "filter": { ... } }`
Response `200`: `{ "segment_id": "uuid", "version": 4, "status": "draft" }`

Error responses: `404` if segment not found. `400` if `filter` is invalid.

---

**`POST /audiences/segments/:id/activate`** — Promote current draft to active. Sets `status = 'active'` and advances `active_version` to `current_version`. Marketing Manager only. Returns `400` if `current_version` has never been saved with a filter.

Response `200`: `{ "segment_id": "uuid", "active_version": 4, "status": "active" }`

Error responses: `404` if segment not found. `403` if caller is not Marketing Manager role. `400` if no filter has been saved for `current_version`.

---

**`POST /audiences/segments/:id/disable`** — Disable segment. Membership checks and evaluate calls on disabled segments return `404`.

Response `200`: `{ "segment_id": "uuid", "status": "disabled" }`

Error responses: `404` if segment not found. `403` if caller is not Marketing Manager role.

---

**`GET /audiences/segments`** — List all segments. Paginated.

Query params: `?limit=100&offset=0`

Response:
```json
{
  "items": [{ "segment_id": "uuid", "name": "...", "status": "active", "active_version": 2, "current_version": 2, "updated_at": "..." }],
  "total": 47
}
```

---

**`GET /audiences/segments/:id`** — Get segment with active filter definition.

Response: `{ segment_id, name, status, active_version, current_version, filter }`

Error responses: `404` if segment not found.

---

### 5.2 Evaluation

**`POST /audiences/segments/:id/evaluate`** — Batch evaluate a named segment. Caller submits entity data in pages, each page referencing the same `snapshot_id`.

Request:
```json
{
  "snapshot_id": "uuid",
  "entities": [
    {
      "entity_id": "lead-abc",
      "pipeline": "new_patient",
      "stage": "contacted",
      "location_id": "loc-1",
      "last_contact_at": "2026-03-18T10:00:00Z",
      "opted_out": false
    }
  ],
  "done": false
}
```

- `snapshot_id` is required. Returns `400` if absent.
- `snapshot_id` is caller-generated (UUID). On first call, the engine creates the snapshot row using `INSERT ... ON CONFLICT (id) DO NOTHING` — concurrent first-batch calls with the same `snapshot_id` are safe; only one row is created.
- Every batch call validates that the existing `audience_snapshots.segment_id` matches the `:id` in the URL. Returns `400` if mismatch — prevents cross-segment snapshot pollution.
- Submitting the same `(snapshot_id, entity_id)` pair twice is idempotent — `INSERT INTO audience_snapshot_members ... ON CONFLICT DO NOTHING`.
- `matched_count` is updated atomically: `UPDATE audience_snapshots SET matched_count = matched_count + $newly_matched` — never read-modify-write.
- `matched_count` reflects only entities that passed the filter, not total submitted entities.
- `done: false` — engine accumulates, returns `{ snapshot_id, matched_count, status: "accumulating" }`.
- `done: true` — engine seals the snapshot, returns `{ snapshot_id, matched_count, status: "ready" }`.
- Returns `404` if segment has no active version or status is `disabled`.
- Returns `400` if `snapshot_id` references a snapshot already in `ready` status.

---

**`POST /audiences/evaluate`** — Inline one-off evaluation. Filter definition passed inline. No segment definition stored.

Request:
```json
{
  "snapshot_id": "uuid",
  "filter": { "op": "AND", "conditions": [...] },
  "entities": [...],
  "done": true,
  "snapshot": false
}
```

- `snapshot_id` is required when `snapshot: true`; ignored (and optional) when `snapshot: false`. Returns `400` if `snapshot: true` and `snapshot_id` is absent.
- `snapshot: false` is only valid with `done: true`. Returns `400` if `snapshot: false` and `done: false` — there is no in-memory accumulation across stateless HTTP calls.
- `snapshot: false` (default) — engine evaluates and returns matched entity IDs in the response body. No snapshot row written.
- `snapshot: true` — engine accumulates into a snapshot (same paging model as named evaluate). Useful for large one-off sends. On first batch, `filter_snapshot` is written from the request's `filter` field. On subsequent batches, if the incoming `filter` does not match the stored `filter_snapshot`, returns `400` — prevents silently mixing different filters across batches for the same snapshot.

Response (`snapshot: false`, `done: true`):
```json
{ "matched_count": 14, "entity_ids": ["lead-abc", "lead-def", ...] }
```

---

**`GET /audiences/snapshots/:snapshot_id`** — Retrieve snapshot members. Paginated.

Query params: `?limit=1000&offset=0`

Response:
```json
{
  "snapshot_id": "uuid",
  "segment_id": "uuid | null",
  "status": "ready",
  "matched_count": 412,
  "expires_at": "2026-03-27T14:00:00Z",
  "entity_ids": ["lead-1", "lead-2", ...]
}
```

`segment_id` is `null` for inline one-off snapshots (created via `POST /audiences/evaluate` with `snapshot: true`).

Returns `404` if snapshot not found or already expired.

---

### 5.3 Membership Check

**`POST /audiences/segments/:id/check`** — Test whether a single entity matches the segment's active filter. No snapshot created, no DB write on the hot path.

Request:
```json
{
  "entity": {
    "entity_id": "lead-abc",
    "pipeline": "new_patient",
    "stage": "contacted",
    "last_contact_at": "2026-03-18T10:00:00Z",
    "opted_out": false
  }
}
```

Response `200`:
```json
{ "matches": true, "segment_id": "uuid", "segment_version": 3 }
```

- Returns `404` if segment has no active version or is disabled.
- Segment resolution is cached: the full resolved segment (group row + active filter) is stored in-memory keyed by `segment_id` with a 30s TTL. A single cache entry per `segment_id` — no secondary cache needed. On a cache miss, the service loads `audience_segments` (to get `active_version`) and `audience_segment_versions` (to get the filter) in one query. Cache invalidated on TTL expiry only — a new version activation or a `disable` operation takes effect within 30 seconds across all running instances. During this window, `check` calls may still return membership results for a recently disabled segment rather than `404`. The `segment_version` returned in the response reflects the version in the cached entry.

---

## 6. Database Schema — `platform_audience`

```sql
-- Segment group: name, status, version pointers
audience_segments (
  id               uuid PRIMARY KEY,
  name             text NOT NULL,
  status           text NOT NULL DEFAULT 'draft',  -- draft|active|disabled
  active_version   integer,                         -- NULL until first activation
  current_version  integer NOT NULL DEFAULT 1,
  created_by       uuid,
  created_at       timestamptz,
  updated_at       timestamptz
)

-- One row per version of a segment's filter definition
audience_segment_versions (
  id           uuid PRIMARY KEY,
  segment_id   uuid REFERENCES audience_segments NOT NULL,
  version      integer NOT NULL,
  filter       jsonb NOT NULL,
  created_by   uuid,
  created_at   timestamptz,
  UNIQUE (segment_id, version)
)

-- One row per evaluate call (named or inline with snapshot:true)
audience_snapshots (
  id               uuid PRIMARY KEY,                          -- caller-supplied
  segment_id       uuid REFERENCES audience_segments,         -- NULL for inline one-offs
  segment_version  integer,
  filter_snapshot  jsonb NOT NULL,                            -- filter at evaluation time
  status           text NOT NULL DEFAULT 'accumulating',      -- accumulating|ready
  matched_count    integer NOT NULL DEFAULT 0,
  expires_at       timestamptz NOT NULL,                      -- created_at + 48h
  created_by       uuid,
  created_at       timestamptz
)

-- One row per matched entity in a snapshot
audience_snapshot_members (
  snapshot_id  uuid REFERENCES audience_snapshots ON DELETE CASCADE NOT NULL,
  entity_id    text NOT NULL,
  PRIMARY KEY (snapshot_id, entity_id)
)
```

**Schema notes:**
- `filter_snapshot` records the exact filter used at evaluation time. If the segment is edited later, the audit record is preserved.
- `audience_snapshot_members` is the high-cardinality table. For a 10,000-lead campaign send: 10k rows, deleted after 48 hours. `ON DELETE CASCADE` ensures members are removed when the snapshot is deleted.
- `matched_count` reflects entities that passed the filter, not total submitted entities. Updated atomically via `UPDATE ... SET matched_count = matched_count + $delta`.
- **Snapshot cleanup — primary path:** BullMQ delayed job enqueued at snapshot creation with `delay = 48h`. On fire: `DELETE FROM audience_snapshots WHERE id = ?` (cascades to members).
- **Snapshot cleanup — safety net:** A BullMQ repeatable job runs every hour: `DELETE FROM audience_snapshots WHERE expires_at < NOW()`. This recovers any snapshots whose primary cleanup job was lost due to Redis eviction or migration. Analogous to the Notification Service TTL cleanup pattern.
- No soft-deletes on segments — `status = 'disabled'` is sufficient.

---

## 7. Service Layout

```
apps/platform/audience/
├── src/
│   ├── routes/
│   │   ├── segments.ts          # CRUD + activate + disable
│   │   ├── evaluate.ts          # POST /audiences/segments/:id/evaluate
│   │   │                        # POST /audiences/evaluate (inline)
│   │   ├── snapshots.ts         # GET /audiences/snapshots/:id
│   │   └── check.ts             # POST /audiences/segments/:id/check
│   ├── services/
│   │   ├── segment-repository.ts   # DB access + 30s in-memory cache
│   │   ├── filter-evaluator.ts     # thin wrapper around @platform/filter-engine
│   │   ├── snapshot-manager.ts     # accumulate batches, seal on done, enqueue cleanup
│   │   ├── snapshot-cleanup.ts     # BullMQ worker — deletes expired snapshot (per-snapshot delayed job)
│   │   └── snapshot-cleanup-sweep.ts  # BullMQ repeatable worker — hourly safety-net sweep
│   ├── repositories/            # DB access (platform_audience schema only)
│   └── index.ts
├── migrations/
├── test/
├── Dockerfile
├── package.json
└── tsconfig.json
```

**Runtime dependencies:**
- PostgreSQL (shared RDS cluster, `platform_audience` schema)
- Redis (BullMQ — snapshot cleanup delayed jobs only)

No SQS. No EventBridge subscription. No outbound HTTP calls during evaluation.

---

## 8. `@platform/audience-ui` React Component

Exported from `packages/@platform/audience-ui`. Calls Audience Engine API directly from the browser (not proxied through CRM API Gateway). Auth via Identity Service JWT token the CRM shell holds.

### Components

**`<SegmentBuilder />`** — Full segment management. Embedded in the Campaign Builder and in the Marketing Staff standalone "Lead segment builder" view (PRD §11.2).

Views:
- **Segment Library** — table of all named segments with name, status, version, and last-used date. Actions: create new, edit draft, activate (Marketing Manager only), disable.
- **Segment Editor** — visual AND/OR filter tree. Each row: field selector, operator selector (populated based on field type), value input. Groups nestable. Live preview count — when `onFetchEntities` is provided, the component calls it with the current filter to retrieve a sample of candidate entities, then posts them to `POST /audiences/evaluate` (inline, `snapshot: false`) to show an estimated audience count before saving.

The CRM configures the available fields and entity data provider at mount time:

```tsx
<SegmentBuilder
  fields={[
    { key: "pipeline",        label: "Pipeline",     type: "string"    },
    { key: "stage",           label: "Stage",        type: "string"    },
    { key: "location_id",     label: "Location",     type: "string"    },
    { key: "lead_source",     label: "Lead Source",  type: "string"    },
    { key: "last_contact_at", label: "Last Contact", type: "timestamp" },
    { key: "opted_out",       label: "Opted Out",    type: "boolean"   },
    { key: "custom_tags",     label: "Tags",         type: "array"     },
  ]}
  onSelect={(segmentId) => { /* Campaign Service captures segment ID */ }}
  onFetchEntities={async (filter) => {
    // CRM calls Lead Service to get a sample of candidate entities.
    // The filter is passed as an optional pre-filter hint — the Lead Service can use
    // CRM-specific fields (pipeline, stage, location) to narrow results before the
    // Audience Engine applies the full filter. Pre-filtering is recommended for large
    // datasets but not required — the Audience Engine will apply all conditions regardless.
    return await leadService.getSample({ limit: 500, hint: filter });
  }}
/>
```

`onFetchEntities` is optional. If omitted, the live preview count is not shown — the Segment Editor still works fully for building and saving the filter. Field `type` drives UI only — which operators are shown and which input widget is rendered. The Audience Engine has no concept of field types.

**`<AudiencePreview segmentId={id} />`** — Read-only component. Renders segment name, filter summary (human-readable), and estimated audience count. Embedded in the Campaign Builder review step so staff can confirm audience before scheduling a send.

---

## 9. Testing Strategy

### `@platform/filter-engine` — Unit Tests (Vitest)

Pure function, exhaustive coverage:
- All base operators: equality, numeric, array membership, string contains, field existence
- All temporal operators: boundary cases (exactly N days ago), DST edge cases, `within_last` / `not_within_last` at unit boundaries (hours vs days)
- Boolean grouping: nested AND/OR/NOT, short-circuit evaluation
- Missing field: `not_exists` passes, all other operators return `false`
- Unknown operator: throws with descriptive error
- Temporal operators without `EvalContext`: throws with descriptive error
- Dot-notation field resolution: nested paths, array fields, null intermediate nodes

### Audience Engine — Unit Tests (Vitest)

- Batch accumulation: multiple pages with the same `snapshot_id` merge correctly
- `done: true` on final batch sets status to `ready` and updates `matched_count`
- Inline evaluate with `snapshot: false` — no snapshot row written, entity IDs returned in response
- Membership check uses cached segment filter on repeat calls (assert DB called only once per 30s window)
- Filter evaluator wrapper passes `EvalContext` with `now` for temporal operators

### Audience Engine — Integration Tests (Vitest + real Postgres + real Redis)

- Full named segment: create → activate → evaluate (3 batches) → GET snapshot → assert correct entity IDs and matched count
- Inline one-off with `snapshot: false` → assert no `audience_snapshots` row written
- Inline one-off with `snapshot: true` → assert snapshot row + members written
- Membership check: active segment → `{ matches: true }`; disabled segment → `404`; no active version → `404`
- Draft segment evaluate → `404`
- Idempotent batch: same `(snapshot_id, entity_id)` submitted twice → single member row, no error
- Snapshot sealed (`ready`) → subsequent batch with same `snapshot_id` → `400`
- `filter_snapshot` on snapshot row matches segment's filter at evaluation time (not a later-edited version)
- Snapshot cleanup primary job fires → `audience_snapshots` row deleted → `audience_snapshot_members` cascade deleted → `GET /audiences/snapshots/:id` returns `404`
- Snapshot cleanup safety-net repeatable job: insert expired snapshot directly in DB (bypassing BullMQ), run hourly job, assert row deleted
- Segment cache: activate new version → membership check within 30s may use old version; after 30s uses new version
- Concurrent first-batch: simulate two simultaneous `POST /audiences/segments/:id/evaluate` calls with the same `snapshot_id` — assert exactly one `audience_snapshots` row created, no error returned to either caller
- Cross-segment snapshot pollution: submit batch with `snapshot_id` that was created for a different segment → `400`
- `snapshot: false` + `done: false` → `400`
- `snapshot: true` + missing `snapshot_id` → `400`
- Malformed filter on `POST /audiences/segments`: unknown operator → `400` with error message; missing `conditions` on `AND` node → `400`; `NOT` node missing `condition` → `400`
- `activate` with no saved filter on `current_version` → `400`
- `GET /audiences/segments` pagination: create 5 segments, assert `?limit=2&offset=0` returns 2, `?offset=2` returns next 2

---

## 10. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Data flow | Hybrid — caller submits entity data | Platform service cannot call product APIs. Caller owns data fetch and enrichment; engine owns filter evaluation and snapshot storage. |
| Segment storage | Named segments + inline one-offs | Reusable named segments for recurring campaigns. Inline one-offs for ad-hoc sends without polluting the segment library. |
| Shared filter evaluator | `@platform/filter-engine` package | Avoids duplicating condition evaluation logic across Automation Engine and Audience Engine. Pure functions, zero runtime dependencies. |
| Extended temporal operators | `within_last`, `not_within_last`, `before`, `after`, `date_range` | Covers all identified audience segmentation needs (date ranges, "no contact in X days"). No aggregate operators — callers enrich entity data with pre-resolved fields. |
| No aggregate operators | Caller enriches entity data | "No contact in X days" is expressed as `last_contact_at not_within_last 5 days` — caller passes `last_contact_at` on each entity. Cross-service data joins stay in the product layer. |
| Snapshot model | Entity IDs only, 48h TTL | Sufficient to drive any campaign send loop. No contact details stored in platform layer — those stay in Lead Service. |
| Snapshot cleanup | BullMQ delayed job per snapshot + hourly safety-net repeatable job | Primary: job enqueued at creation with `delay = 48h`. Safety-net: hourly repeatable job cleans up any snapshots whose primary job was lost (Redis eviction, migration). Same pattern as Notification Service TTL cleanup. |
| Membership check | Synchronous, no snapshot, cached | Fast in-memory evaluation for Automation Engine rule conditions and product-layer scoring. Full resolved segment (group + filter) cached by `segment_id` with 30s TTL — one DB query on cache miss, zero DB queries on cache hit. |
| Versioning | Same active/draft pattern as Automation Engine and Nurturing Engine | Consistent across platform services. Active version evaluates; editing a draft does not affect running campaigns. |
| `filter_snapshot` on snapshot | Full filter JSON copied at evaluation time | Audit record: exact criteria that produced this audience are preserved regardless of subsequent segment edits. |
| No EventBridge | None | Purely synchronous REST service. No side effects, no async workers beyond snapshot cleanup. Simplest runtime of all platform services. |
