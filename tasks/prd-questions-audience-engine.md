# Clarifying Questions: Audience Engine

> Original request: Generate a PRD for the Audience Engine based on the approved design spec at `docs/superpowers/specs/2026-03-25-audience-engine-design.md`.

## Questions

### Multi-Tenancy & Data Isolation

1. Does the Audience Engine need to isolate segments and snapshots by organization/tenant? The spec has no `org_id` on any table — is that intentional?
	A. No isolation needed — Ortho CRM is a single-tenant deployment; all data is shared
	B. Add `org_id` (or `location_id`) to `audience_segments` and filter all queries by it
	C. Isolation is handled at the Identity Service JWT level (scoped tokens, not DB rows)
	D. Other: [please specify]

	**Answer:** A

2. Should segment visibility be scoped to location, or are segments shared across all 34 locations?
	A. Segments are global — any marketing staff across all locations can use any segment
	B. Segments are scoped to a location — each location has its own segment library
	C. Segments are global but can be tagged with optional location hints for filtering
	D. Other: [please specify]

	**Answer:** A

---

### API & Request Contracts

3. The spec lists various `400`/`404`/`403` error responses but doesn't specify the error body format. What shape should error responses use?
	A. Match the existing platform service pattern: `{ "error": { "code": "...", "message": "..." } }`
	B. Simple `{ "message": "..." }` only
	C. Follow JSON:API errors format
	D. Other: [please specify]

	**Answer:** C

4. Should `GET /audiences/segments` support filtering by status (`draft`, `active`, `disabled`) in addition to pagination?
	A. No — the caller paginates and filters client-side
	B. Yes — add `?status=active` query param (single value)
	C. Yes — add `?status=active,draft` (comma-separated multi-value)
	D. Other: [please specify]

	**Answer:** C

5. `GET /audiences/segments/:id` returns "active filter definition." What should be returned when the segment is in `draft` status (no active version yet)?
	A. Return the segment metadata with `filter: null` and `active_version: null`
	B. Return `404` — draft segments are not externally visible until activated
	C. Return the latest draft filter regardless of activation status
	D. Other: [please specify]

	**Answer:** A

6. Should there be a maximum number of entities allowed per batch request to `POST /audiences/segments/:id/evaluate`?
	A. No hard limit — caller manages batch sizing
	B. Yes — enforce a limit (e.g. 1000 entities per call) and return `400` if exceeded
	C. Yes — but return `413 Payload Too Large` if exceeded
	D. Other: [please specify]

	**Answer:** C

7. Should there be a maximum total snapshot size (total entities across all batches for a single `snapshot_id`)?
	A. No limit
	B. Yes — cap at a defined maximum (e.g. 100,000 entities) and return `400` on the batch that would exceed it
	C. No cap, but log a warning metric above a threshold
	D. Other: [please specify]

	**Answer:** B

---

### Versioning & Segment Lifecycle

8. When `POST /audiences/segments` creates a new segment (status `draft`, version `1`), is a row immediately written to `audience_segment_versions`, or only on the first `PUT`?
	A. No version row on create — `PUT` creates the first version row
	B. Version row (version=1) written at create time using the `filter` from the request body (filter is required on create)
	C. Version row (version=1) written at create time, but the `filter` field is optional on create (row written with null/empty filter if omitted)
	D. Other: [please specify]
	
	**Answer:** B

9. `PUT /audiences/segments/:id` says it "increments `current_version`" — does it always create a new `audience_segment_versions` row, or does it overwrite the existing draft version row?
	A. Always creates a new row (version=N+1) — full history of drafts is preserved
	B. Overwrites the current draft row in place (no version history for unpublished drafts)
	C. Creates a new row only if `current_version` has already been activated; otherwise overwrites
	D. Other: [please specify]
	
	**Answer:** C

10. The `audience_snapshots` table has a `segment_version` column. Is this populated with the segment's `active_version` at snapshot creation time? Should it also appear in API responses?
	A. Yes — populated from `active_version` at creation, and exposed in `GET /audiences/snapshots/:id` response
	B. Yes — populated internally for audit, but not exposed in the API response
	C. Not populated (leave `NULL`) — `filter_snapshot` already captures what was evaluated
	D. Other: [please specify]
	
	**Answer:** A

---

### Snapshot & Cleanup Behavior

11. The 48-hour snapshot TTL is hardcoded in the spec. Should this be configurable?
	A. No — 48 hours is fixed and sufficient
	B. Yes — configurable via environment variable at service level (same TTL for all snapshots)
	C. Yes — configurable per evaluate call via an optional `ttl_hours` request field
	D. Other: [please specify]
	
	**Answer:** A

12. When a snapshot is in `accumulating` status (batches still being submitted), what should `GET /audiences/snapshots/:id` return?
	A. Return the current partial state: `status: "accumulating"`, current `matched_count`, and current `entity_ids` so far
	B. Return `404` or `409` — snapshots are only retrievable once sealed (`ready`)
	C. Return metadata only (`matched_count`, `status`) without `entity_ids` until `ready`
	D. Other: [please specify]
	
	**Answer:** A

13. If the BullMQ snapshot cleanup job fires but the snapshot has already been manually deleted (e.g., by a future admin API), should the worker throw or silently succeed?
	A. Silently succeed (no-op if row not found — `DELETE WHERE id = ?` returns 0 rows, that's fine)
	B. Log a warning but still succeed
	C. Throw and let BullMQ retry
	D. Other: [please specify]
	
	**Answer:** A

---

### In-Memory Cache

14. The 30-second membership-check cache — is this **per ECS instance** (each container has its own in-memory cache), or should it be a shared Redis cache?
	A. Per-instance in-memory (each container has its own cache) — acceptable because 30s TTL is short and temporary staleness is tolerable
	B. Shared Redis cache keyed by `segment_id` — ensures consistency across all instances
	C. Per-instance for now, with a TODO comment to migrate to Redis if needed
	D. Other: [please specify]
	
	**Answer:** A

15. Should a segment disable or version activation event **proactively invalidate** the in-memory cache (e.g., via a Redis pub/sub broadcast to all instances), or rely solely on TTL expiry?
	A. TTL expiry only — the spec already documents up to 30s staleness as acceptable
	B. Proactive invalidation via Redis pub/sub broadcast on activate/disable
	C. Proactive invalidation only on `disable` (because it changes membership to 404); TTL is fine for version changes
	D. Other: [please specify]
	
	**Answer:** A

---

### `@platform/filter-engine` Package

16. The spec says the Automation Engine's existing `condition-evaluator.ts` should be replaced with a wrapper around `@platform/filter-engine`. Should this migration happen as part of the Audience Engine implementation, or in a separate subsequent task?
	A. Same task — build `@platform/filter-engine` and migrate the Automation Engine in one go
	B. Separate task — build `@platform/filter-engine` as part of Audience Engine, but migrate the Automation Engine in a follow-up
	C. Defer entirely — the Automation Engine migration is out of scope for this spec
	D. Other: [please specify]
	
	**Answer:** B

17. For temporal operator boundary conditions: is `within_last 5 days` **inclusive** of exactly 5 days ago (i.e., `timestamp >= now - 5d`) or **exclusive** (`timestamp > now - 5d`)?
	A. Inclusive — `>= now - N` (the boundary moment itself counts as "within last N")
	B. Exclusive — `> now - N` (the boundary moment does not count)
	C. Inclusive at the start, exclusive at the end (standard interval semantics)
	D. Other: [please specify]
	
	**Answer:** A

---

### `@platform/audience-ui` React Component

18. How is `@platform/audience-ui` distributed and consumed?
	A. Local Turborepo workspace package only — no npm publish, imported as `"@platform/audience-ui": "*"` in consuming apps
	B. Published to a private npm registry (e.g., GitHub Packages or Artifactory)
	C. Bundled directly into the CRM web app — no separate package
	D. Other: [please specify]
	
	**Answer:** C

19. In the `<SegmentBuilder>` live preview count, when `onFetchEntities` is provided: should debouncing be built into the component, and if so, what delay?
	A. Yes — debounce filter changes at 500ms before triggering `onFetchEntities` + evaluate
	B. Yes — debounce at 1000ms (1 second)
	C. No debouncing in the component — the consumer is responsible for debouncing `onFetchEntities`
	D. Other: [please specify]
	
	**Answer:** A

20. Should `<SegmentBuilder>` show an error state when the live preview evaluate call fails (e.g., network error, 400 from invalid filter mid-edit)?
	A. Yes — show an inline error message below the filter builder
	B. Silently hide the count (show no estimate) without showing an error message
	C. Show a neutral "—" placeholder with a tooltip explaining the count is unavailable
	D. Other: [please specify]
	
	**Answer:** A

---

### Data Integrity & Security

21. The `created_by` field on segments and snapshots — is this auto-populated from the JWT sub claim server-side, or is the caller expected to pass it in the request body?
	A. Auto-populated from the JWT `sub` claim — callers never pass `created_by`
	B. Caller passes it explicitly in the request body
	C. Not populated — leave `NULL` for now; audit logging is out of scope
	D. Other: [please specify]
	
	**Answer:** A

22. For `POST /audiences/segments/:id/evaluate`, the spec says the engine validates that `snapshot.segment_id` matches the URL `:id`. Should this validation also check that the JWT caller identity that created the snapshot matches the current caller?
	A. No — any authenticated service can append to any snapshot as long as the `segment_id` matches
	B. Yes — lock the snapshot to the `created_by` identity from the first batch
	C. Yes — lock to the service identity (not the user), since Campaign Service always owns the evaluate flow
	D. Other: [please specify]
	
	**Answer:** A

---

### Observability & Operations

23. What Datadog metrics should the Audience Engine emit?
	A. Minimal — request latency and error rates from the APM agent only (no custom metrics)
	B. Standard set: request latency, error rate, plus custom counters for snapshot seal events and batch evaluate calls
	C. Extended: all of B plus cache hit/miss ratio, snapshot member count histogram, BullMQ queue depth
	D. Other: [please specify]
	
	**Answer:** B

24. Should the service expose a health-check endpoint (e.g., `GET /health`) that verifies Postgres and Redis connectivity?
	A. Yes — `GET /health` returns `200` if both Postgres and Redis are reachable; `503` otherwise
	B. Yes — `GET /health` always returns `200` (liveness only, no dependency checks)
	C. No dedicated health endpoint — rely on ECS/ALB default health checks
	D. Other: [please specify]
	
	**Answer:** B

---

### Database Indexes

25. The spec defines PKs and a unique constraint on `(segment_id, version)` but doesn't list query indexes. Which indexes are needed beyond those constraints?
	A. Minimal — only what's needed for the 30s cache miss query (`audience_segments.id` is PK, already indexed)
	B. Add: `audience_snapshots(expires_at)` for the hourly safety-net sweep; `audience_segment_versions(segment_id, version)` is covered by the unique constraint
	C. Full set: `audience_snapshots(expires_at)`, `audience_snapshots(segment_id)`, `audience_segments(status)` for the list endpoint
	D. Other: [please specify]
	
	**Answer:** C
