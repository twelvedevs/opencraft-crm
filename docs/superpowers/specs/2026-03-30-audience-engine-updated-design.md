# Audience Engine — Updated Design Spec

**Date:** 2026-03-30
**Status:** Approved
**Scope:** Platform-layer Audience Engine — named segment registry, batch evaluation with caller-supplied entity data, audience snapshots, single-entity membership checks, shared `@platform/filter-engine` package, `@platform/audience-ui` React component.
**Supersedes:** `2026-03-25-audience-engine-design.md`
**Change source:** Answers to clarifying questions in `tasks/prd-questions-audience-engine.md`

---

## 1. Overview

The Audience Engine is a **platform-layer service** (`apps/platform/audience`) that stores named segment definitions, evaluates filter criteria against caller-supplied entity data, and produces audience snapshots for campaign sends. It is fully generic — it has no knowledge of Ortho CRM concepts such as leads, pipelines, or stages.

**Core responsibilities:**
- Store versioned named segment definitions (filter DSL)
- Evaluate segments against caller-submitted entity data (batched) and accumulate audience snapshots
- Support inline one-off evaluation without storing a segment definition
- Answer single-entity membership checks synchronously (for Automation Engine and product services)
- Ship `@platform/audience-ui` React component (bundled into CRM web app) for staff to build and manage segments
- Export `@platform/filter-engine` — a shared pure-function filter evaluator used by both the Audience Engine and the Automation Engine

**Out of scope:**
- Fetching entity data from product services (caller always provides entity data)
- Real-time audience updates or change subscriptions
- Contact detail storage (entity IDs only — contact details stay in Lead Service)
- Audience send orchestration (Campaign Service drives the send loop)
- Automation Engine migration to `@platform/filter-engine` (separate follow-up task)

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
4. Campaign Service submits entity data in batches of up to 1,000 to `POST /audiences/segments/:id/evaluate` with a caller-generated `snapshot_id`
5. On final batch (`done: true`), engine seals the snapshot (status → `ready`)
6. Campaign Service calls `GET /audiences/snapshots/:snapshot_id` to retrieve entity IDs and drive the send loop

**Data flow — membership check:**
- Automation Engine or product service calls `POST /audiences/segments/:id/check` with a single entity record
- Engine loads segment's active filter from per-instance in-memory cache, evaluates in-memory, returns `{ matches: bool }`
- No snapshot created, no DB write on the hot path

**No EventBridge integration.** The Audience Engine is purely synchronous REST — no event subscriptions, no BullMQ action workers, no async side effects beyond snapshot cleanup.

**Golden rule compliance:** The engine never calls product-layer APIs. All entity data is pushed by the caller. The engine is a filter runtime and snapshot store — it has no knowledge of what field values like `"new_patient"` or `"contacted"` mean.

**Multi-tenancy:** Ortho CRM is a single-tenant deployment. No `org_id` or `location_id` isolation at the DB row level. Segments are global across all 34 locations — any marketing staff can create, edit, or use any segment.

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

**Temporal boundary semantics:** `within_last N days` is **inclusive** — the condition is `timestamp >= now - N` (the boundary moment itself counts as "within last N"). `not_within_last N days` is therefore `timestamp < now - N`.

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

**Automation Engine migration:** Building `@platform/filter-engine` is in scope for this task. Migrating the existing `condition-evaluator.ts` in `apps/platform/automation` to use the new package is a **separate follow-up task** — it will be a drop-in replacement with identical behavior, but is decoupled from the Audience Engine delivery. Until migration, both implementations coexist.

---

## 5. API

All endpoints require an Identity Service JWT. Segment creation and activation require Marketing Manager role. Evaluate and check endpoints are callable by any authenticated service.

### 5.1 Error Response Format

All error responses follow **JSON:API errors format**:

```json
{
  "errors": [
    {
      "status": "400",
      "code": "INVALID_FILTER",
      "title": "Invalid filter definition",
      "detail": "AND node is missing required 'conditions' array"
    }
  ]
}
```

The `status` field is the HTTP status code as a string. `code` is a machine-readable constant. `title` is a short human-readable summary. `detail` is an optional longer explanation.

### 5.2 Segment Management

**`POST /audiences/segments`** — Create a new named segment.

- The `filter` field is **required** on creation.
- On success, a segment row (`status: 'draft'`, `current_version: 1`) and a version row (`version: 1`) are both written atomically in a single transaction.
- `created_by` is auto-populated from the JWT `sub` claim — callers do not pass it.

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

Error responses: `400` if `filter` is absent or structurally invalid (unknown operator, missing required fields, `NOT` node missing `condition`, `AND`/`OR` node missing `conditions` array).

---

**`PUT /audiences/segments/:id`** — Save a new or updated draft filter.

Versioning behavior depends on whether the current draft has been activated:
- If `current_version` **has never been activated** (i.e., `current_version > active_version` or `active_version IS NULL`): overwrite the existing `audience_segment_versions` row for `current_version` in place. No version increment. No history kept for unactivated drafts.
- If `current_version` **has been activated** (i.e., `current_version == active_version`): create a new version row at `current_version + 1` and increment `current_version` on the segment row.

This ensures full history is preserved for every version that was ever activated, while avoiding unbounded draft history for segments still being edited before first publish.

Request: `{ "filter": { ... } }`
Response `200`: `{ "segment_id": "uuid", "version": 4, "status": "draft" }`

Error responses: `404` if segment not found. `400` if `filter` is invalid.

---

**`POST /audiences/segments/:id/activate`** — Promote current draft to active. Sets `status = 'active'` and advances `active_version` to `current_version`. Marketing Manager only.

Response `200`: `{ "segment_id": "uuid", "active_version": 4, "status": "active" }`

Error responses: `404` if segment not found. `403` if caller is not Marketing Manager role. `400` if no filter version row exists for `current_version`.

---

**`POST /audiences/segments/:id/disable`** — Disable segment. Membership checks and evaluate calls on disabled segments return `404`.

Response `200`: `{ "segment_id": "uuid", "status": "disabled" }`

Error responses: `404` if segment not found. `403` if caller is not Marketing Manager role.

---

**`GET /audiences/segments`** — List all segments. Paginated with optional status filter.

Query params:
- `?limit=100&offset=0` — pagination
- `?status=active` or `?status=active,draft` — comma-separated multi-value filter by status. If omitted, all statuses are returned.

Response:
```json
{
  "items": [{ "segment_id": "uuid", "name": "...", "status": "active", "active_version": 2, "current_version": 2, "updated_at": "..." }],
  "total": 47
}
```

---

**`GET /audiences/segments/:id`** — Get segment with active filter definition.

- If `status = 'active'`: returns segment metadata + `filter` from the active version.
- If `status = 'draft'` (no active version yet): returns segment metadata with `filter: null` and `active_version: null`. The current draft filter is not exposed here — callers manage drafts via `PUT`.
- If `status = 'disabled'`: returns segment metadata with `filter: null`.

Response: `{ segment_id, name, status, active_version, current_version, filter }`

Error responses: `404` if segment not found.

---

### 5.3 Evaluation

**`POST /audiences/segments/:id/evaluate`** — Batch evaluate a named segment.

**Batch size limit:** Each request may contain at most **1,000 entities**. If exceeded, returns `413 Payload Too Large`.

**Total snapshot size limit:** A single snapshot may accumulate at most **100,000 matched entities** across all batches. If a batch would push the total above this cap, the engine returns `400` with error code `SNAPSHOT_SIZE_EXCEEDED`. Partially-matched entities from that batch are not written.

Caller submits entity data in pages, each page referencing the same `snapshot_id`. `created_by` is auto-populated from the JWT `sub` claim on first batch creation.

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
- `snapshot_id` is caller-generated (UUID). On first call, the engine creates the snapshot row using `INSERT ... ON CONFLICT (id) DO NOTHING`. Concurrent first-batch calls with the same `snapshot_id` are safe; only one row is created. `filter_snapshot` is populated from the segment's active filter at row-creation time (read in the same transaction that validates the segment is active). `segment_version` is populated from the segment's `active_version` at snapshot creation time.
- Every batch call validates that the existing `audience_snapshots.segment_id` matches the `:id` in the URL. Returns `400` if mismatch — prevents cross-segment snapshot pollution.
- Submitting the same `(snapshot_id, entity_id)` pair twice is idempotent — `INSERT INTO audience_snapshot_members ... ON CONFLICT DO NOTHING`.
- `matched_count` is updated atomically: `UPDATE audience_snapshots SET matched_count = matched_count + $newly_matched`.
- `matched_count` reflects only entities that passed the filter, not total submitted entities.
- Any authenticated service may submit batches to any snapshot as long as the `segment_id` matches — no JWT identity lock on subsequent batches.
- `done: false` — engine accumulates, returns `{ snapshot_id, matched_count, status: "accumulating" }`.
- `done: true` — engine seals the snapshot, returns `{ snapshot_id, matched_count, status: "ready" }`.
- Returns `404` if segment has no active version or status is `disabled`.
- Returns `400` if `snapshot_id` references a snapshot already in `ready` status.
- Returns `413` if batch contains more than 1,000 entities.
- Returns `400` with `SNAPSHOT_SIZE_EXCEEDED` if total would exceed 100,000 matched entities.

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

- **Batch size limit:** at most 1,000 entities per request. Returns `413` if exceeded.
- `snapshot_id` is required when `snapshot: true`; ignored (and optional) when `snapshot: false`. Returns `400` if `snapshot: true` and `snapshot_id` is absent.
- `snapshot: false` is only valid with `done: true`. Returns `400` if `snapshot: false` and `done: false` — there is no in-memory accumulation across stateless HTTP calls.
- `snapshot: false` (default) — engine evaluates and returns matched entity IDs in the response body. No snapshot row written.
- `snapshot: true` — engine accumulates into a snapshot (same paging model as named evaluate). On first batch, `filter_snapshot` is written from the request's `filter` field. On subsequent batches, if the incoming `filter` does not match the stored `filter_snapshot`, returns `400` — prevents silently mixing different filters across batches. **Total snapshot size limit of 100,000 matched entities applies** here as well.
- `created_by` is auto-populated from the JWT `sub` claim on first batch creation.

Response (`snapshot: false`, `done: true`):
```json
{ "matched_count": 14, "entity_ids": ["lead-abc", "lead-def", ...] }
```

---

**`GET /audiences/snapshots/:snapshot_id`** — Retrieve snapshot members. Paginated.

Query params: `?limit=1000&offset=0`

- Returns snapshot data regardless of `status`. If `status: "accumulating"`, returns the current partial state including entity IDs accumulated so far — useful for monitoring progress of large batch evaluations.
- Returns `404` if snapshot not found or already expired.

Response:
```json
{
  "snapshot_id": "uuid",
  "segment_id": "uuid | null",
  "segment_version": 3,
  "status": "ready",
  "matched_count": 412,
  "expires_at": "2026-03-27T14:00:00Z",
  "entity_ids": ["lead-1", "lead-2", ...]
}
```

`segment_id` is `null` for inline one-off snapshots (created via `POST /audiences/evaluate` with `snapshot: true`).
`segment_version` is `null` for inline one-off snapshots.

---

### 5.4 Membership Check

**`POST /audiences/segments/:id/check`** — Test whether a single entity matches the segment's active filter.

No snapshot created, no DB write on the hot path. The full resolved segment (group row + active filter) is cached **per ECS instance** in-memory, keyed by `segment_id`, with a **30-second TTL**. Cache invalidation is by TTL expiry only — no proactive invalidation on segment activation or disable. This means:
- A newly activated version may take up to 30s to be used for membership checks across all instances.
- A disabled segment may still return match results (instead of `404`) for up to 30s after disabling.
- This staleness window is accepted as a design trade-off.

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

`segment_version` reflects the version held in the cached entry at the time of evaluation.

- Returns `404` if segment has no active version or is disabled (subject to 30s cache staleness window).
- On a cache miss: loads `audience_segments` and `audience_segment_versions` in a single join query.

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
  created_by       uuid,                            -- auto-populated from JWT sub
  created_at       timestamptz,
  updated_at       timestamptz
)

-- One row per version of a segment's filter definition
audience_segment_versions (
  id           uuid PRIMARY KEY,
  segment_id   uuid REFERENCES audience_segments NOT NULL,
  version      integer NOT NULL,
  filter       jsonb NOT NULL,
  created_by   uuid,                                -- auto-populated from JWT sub
  created_at   timestamptz,
  UNIQUE (segment_id, version)
)

-- One row per evaluate call (named or inline with snapshot:true)
audience_snapshots (
  id               uuid PRIMARY KEY,                          -- caller-supplied
  segment_id       uuid REFERENCES audience_segments,         -- NULL for inline one-offs
  segment_version  integer,                                   -- active_version at creation; NULL for inline
  filter_snapshot  jsonb NOT NULL,                            -- filter at evaluation time
  status           text NOT NULL DEFAULT 'accumulating',      -- accumulating|ready
  matched_count    integer NOT NULL DEFAULT 0,
  expires_at       timestamptz NOT NULL,                      -- created_at + 48h (fixed, not configurable)
  created_by       uuid,                                      -- auto-populated from JWT sub
  created_at       timestamptz
)

-- One row per matched entity in a snapshot
audience_snapshot_members (
  snapshot_id  uuid REFERENCES audience_snapshots ON DELETE CASCADE NOT NULL,
  entity_id    text NOT NULL,
  PRIMARY KEY (snapshot_id, entity_id)
)
```

### Indexes

Beyond PKs and the `UNIQUE (segment_id, version)` constraint:

```sql
-- Status filter on the list endpoint
CREATE INDEX ON audience_segments (status);

-- Foreign key lookup and segment-scoped snapshot queries
CREATE INDEX ON audience_snapshots (segment_id);

-- Hourly safety-net sweep for expired snapshots
CREATE INDEX ON audience_snapshots (expires_at);
```

### Schema notes

- `filter_snapshot` records the exact filter used at evaluation time. If the segment is edited later, the audit record is preserved.
- `audience_snapshot_members` is the high-cardinality table. For a 10,000-lead campaign send: 10k rows, deleted after 48 hours. `ON DELETE CASCADE` ensures members are removed when the snapshot is deleted.
- `matched_count` reflects entities that passed the filter, not total submitted entities. Updated atomically via `UPDATE ... SET matched_count = matched_count + $delta`.
- **Snapshot TTL is fixed at 48 hours** — not configurable per call or via environment variable.
- **Snapshot cleanup — primary path:** BullMQ delayed job enqueued at snapshot creation with `delay = 48h`. On fire: `DELETE FROM audience_snapshots WHERE id = ?` (cascades to members). If the snapshot was already deleted (e.g., future admin API), the worker silently no-ops — `DELETE WHERE id = ?` returning 0 rows is not an error.
- **Snapshot cleanup — safety net:** A BullMQ repeatable job runs every hour: `DELETE FROM audience_snapshots WHERE expires_at < NOW()`. This recovers any snapshots whose primary cleanup job was lost due to Redis eviction or migration.
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
│   │   ├── segment-repository.ts   # DB access + 30s per-instance in-memory cache
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

## 8. Observability

### Health Check

**`GET /health`** — Liveness probe only. Always returns `200 OK` with `{ "status": "ok" }`. No Postgres or Redis connectivity check is performed. ECS/ALB uses this endpoint for health monitoring.

### Datadog Metrics

The service emits the following custom metrics in addition to APM-provided request latency and error rates:

| Metric | Type | Description |
|---|---|---|
| `audience.snapshot.sealed` | Counter | Incremented each time a snapshot transitions to `ready` status |
| `audience.evaluate.batch_calls` | Counter | Total batch evaluate calls (named + inline) |
| `audience.evaluate.entity_count` | Histogram | Number of entities per batch call |
| `audience.snapshot.matched_count` | Histogram | Total matched entities per sealed snapshot |

All custom metrics are tagged with `service:audience-engine` and `env:<environment>`.

---

## 9. `@platform/audience-ui` React Component

**Distribution:** Bundled directly into `apps/crm/web` — not published as a standalone npm package. Imported as a local workspace dependency from `packages/@platform/audience-ui`. Calls Audience Engine API directly from the browser (not proxied through CRM API Gateway). Auth via Identity Service JWT token the CRM shell holds.

### Components

**`<SegmentBuilder />`** — Full segment management. Embedded in the Campaign Builder and in the Marketing Staff standalone "Lead segment builder" view.

Views:
- **Segment Library** — table of all named segments with name, status, version, and last-used date. Actions: create new, edit draft, activate (Marketing Manager only), disable.
- **Segment Editor** — visual AND/OR filter tree. Each row: field selector, operator selector (populated based on field type), value input. Groups nestable.

**Live preview count:** When `onFetchEntities` is provided, the component calls it with the current filter (debounced at **500ms** after the last filter change) to retrieve a sample of candidate entities, then posts them to `POST /audiences/evaluate` (inline, `snapshot: false`) to show an estimated audience count before saving.

**Error handling:** If the live preview evaluate call fails (network error, `400` from invalid filter mid-edit), the component shows an **inline error message** below the filter builder (e.g., "Could not estimate audience size. Check your filter and try again."). The filter editor remains fully functional — the error is advisory only.

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

## 10. Testing Strategy

### `@platform/filter-engine` — Unit Tests (Vitest)

Pure function, exhaustive coverage:
- All base operators: equality, numeric, array membership, string contains, field existence
- All temporal operators: boundary cases (exactly N days ago — inclusive), DST edge cases, `within_last` / `not_within_last` at unit boundaries (hours vs days)
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
- `PUT` on unactivated draft: version row overwritten, `current_version` unchanged
- `PUT` after activation: new version row created, `current_version` incremented

### Audience Engine — Integration Tests (Vitest + real Postgres + real Redis)

- Full named segment: create → activate → evaluate (3 batches) → GET snapshot → assert correct entity IDs, matched count, and `segment_version`
- Inline one-off with `snapshot: false` → assert no `audience_snapshots` row written
- Inline one-off with `snapshot: true` → assert snapshot row + members written, `segment_id: null`, `segment_version: null`
- Membership check: active segment → `{ matches: true }`; disabled segment → `404`; no active version → `404`
- Draft segment evaluate → `404`
- Idempotent batch: same `(snapshot_id, entity_id)` submitted twice → single member row, no error
- Snapshot sealed (`ready`) → subsequent batch with same `snapshot_id` → `400`
- `filter_snapshot` on snapshot row matches segment's filter at evaluation time (not a later-edited version)
- Snapshot cleanup primary job fires → `audience_snapshots` row deleted → `audience_snapshot_members` cascade deleted → `GET /audiences/snapshots/:id` returns `404`
- Snapshot cleanup job fires on already-deleted snapshot → no error, silently no-ops
- Snapshot cleanup safety-net repeatable job: insert expired snapshot directly in DB (bypassing BullMQ), run hourly job, assert row deleted
- Segment cache: activate new version → membership check within 30s may use old version; after 30s uses new version
- Concurrent first-batch: simulate two simultaneous `POST /audiences/segments/:id/evaluate` calls with the same `snapshot_id` — assert exactly one `audience_snapshots` row created, no error returned to either caller
- Cross-segment snapshot pollution: submit batch with `snapshot_id` that was created for a different segment → `400`
- Batch size limit: submit 1001 entities → `413`
- Total snapshot size limit: accumulate batches that would push matched entities above 100,000 → `400` with `SNAPSHOT_SIZE_EXCEEDED`
- `snapshot: false` + `done: false` → `400`
- `snapshot: true` + missing `snapshot_id` → `400`
- Inline snapshot filter mismatch across batches → `400`
- Malformed filter on `POST /audiences/segments`: unknown operator → `400` with JSON:API error body; missing `conditions` on `AND` node → `400`; `NOT` node missing `condition` → `400`
- `POST /audiences/segments` with missing `filter` → `400`
- `activate` with no saved filter for `current_version` → `400`
- `GET /audiences/segments/:id` for draft segment → `filter: null, active_version: null`
- `GET /audiences/segments?status=active,draft` → returns only active and draft segments
- `GET /audiences/snapshots/:id` while `status: "accumulating"` → returns partial `entity_ids` and current `matched_count`
- `GET /audiences/segments` pagination: create 5 segments, assert `?limit=2&offset=0` returns 2, `?offset=2` returns next 2
- `GET /health` → `200 OK` always

---

## 11. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Multi-tenancy | None (single-tenant) | Ortho CRM is a single-tenant deployment. Segments are global across all locations. |
| Segment visibility | Global | Any marketing staff can use any segment across all 34 locations. |
| Error format | JSON:API errors | Consistent with platform-wide API conventions. |
| Data flow | Hybrid — caller submits entity data | Platform service cannot call product APIs. Caller owns data fetch and enrichment; engine owns filter evaluation and snapshot storage. |
| Segment storage | Named segments + inline one-offs | Reusable named segments for recurring campaigns. Inline one-offs for ad-hoc sends without polluting the segment library. |
| POST create | filter required; version row written at create | Ensures every segment has a valid filter from its first save. No "empty segment" state to handle. |
| PUT versioning | Overwrite draft if not yet activated; new version if activated | Avoids unbounded draft history while preserving full history for every activated version. |
| Shared filter evaluator | `@platform/filter-engine` package | Avoids duplicating condition evaluation logic. Automation Engine migration is a follow-up task. |
| Temporal boundary | `within_last` is inclusive (`>= now - N`) | The boundary moment itself counts as "within last N". Consistent with user expectations. |
| Extended temporal operators | `within_last`, `not_within_last`, `before`, `after`, `date_range` | Covers all identified audience segmentation needs. |
| No aggregate operators | Caller enriches entity data | Cross-service data joins stay in the product layer. |
| Batch size limit | 1,000 entities → `413` | Prevents oversized payloads. Callers manage pagination. |
| Total snapshot cap | 100,000 matched entities → `400` | Guards against unbounded storage growth for runaway sends. |
| segment_version on snapshot | Populated from active_version at creation; exposed in API | Full audit trail: both `filter_snapshot` (what criteria) and `segment_version` (which version of the segment) are preserved. |
| GET snapshot while accumulating | Return partial state including entity_ids | Allows callers to monitor large batch evaluations in progress. |
| Snapshot model | Entity IDs only, 48h TTL (fixed) | Sufficient to drive any campaign send loop. No contact details stored in platform layer. TTL is fixed — no per-call configurability needed. |
| Snapshot cleanup | BullMQ delayed job per snapshot + hourly safety-net repeatable job | Primary: 48h delay. Safety-net: hourly sweep. Silent no-op if snapshot already deleted. |
| Membership check cache | Per-instance in-memory, 30s TTL, TTL expiry only | Fast in-memory evaluation. Per-instance is acceptable given 30s staleness tolerance. No Redis pub/sub needed. |
| `@platform/audience-ui` distribution | Bundled into CRM web app | No separate npm publish needed for a single consumer. |
| SegmentBuilder debounce | 500ms | Balances responsiveness with API call volume during filter editing. |
| SegmentBuilder error state | Inline error message | Users need to know when the count is unavailable and why. |
| `created_by` | Auto-populated from JWT `sub` | Callers never pass `created_by`. Consistent with platform auth conventions. |
| Snapshot caller identity | Any authenticated service can append | Any service with a valid JWT and matching `segment_id` may submit batches. No per-snapshot caller lock. |
| Datadog metrics | Standard set | Request latency + error rates from APM, plus custom counters for snapshot seals and batch calls, histograms for entity counts and matched counts. |
| Health check | Liveness only (`GET /health` always `200`) | ECS/ALB handles liveness. No dependency checks — Postgres or Redis unavailability surfaces through APM errors, not the health endpoint. |
| Database indexes | `audience_segments(status)`, `audience_snapshots(segment_id)`, `audience_snapshots(expires_at)` | Covers list-by-status, segment-scoped snapshot queries, and hourly expiry sweep. |
| No EventBridge | None | Purely synchronous REST service. No side effects beyond snapshot cleanup. Simplest runtime of all platform services. |
