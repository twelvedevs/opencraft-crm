# Clarifying Questions: Lead Service

> Original request: Generate PRD for the Lead Service as specified in `docs/superpowers/specs/2026-03-25-lead-service-design.md` — core lead entity store, deduplication, merge, SQS event worker, activity timeline, tag registry, appointment records, rule-based priority score, and contact status management.

## Questions

1. The spec describes a "BullMQ worker, SQS polling" architecture for event ingestion. The `@ortho/event-bus` package already abstracts SQS polling behind a `Driver` interface (`EventBridgeDriver` in prod, `RedisStreamsDriver` locally). Which approach should Ralph use?
   A. Use `@ortho/event-bus` directly — register all 13 event subscriptions via `bus.subscribe()` before `bus.start()`; no BullMQ dependency needed
   B. Use BullMQ as the job queue with a custom SQS polling loop that feeds jobs into BullMQ workers — `@ortho/event-bus` is not used
   C. Use `@ortho/event-bus` for subscription/publish, and wrap each handler invocation in a BullMQ job for retry/backoff semantics on top of the bus
   D. Other: [please specify]

   **Answer:** A

2. The spec says `score` is "recalculated synchronously inside the SQS worker on relevant events." What should the initial score be when a lead is first created via `POST /leads` (before any events are processed)?
   A. `0` — score starts at zero and climbs once the worker processes `lead.stage_changed`
   B. A computed value from `score-calculator.ts` run inline during `POST /leads` using creation data (channel, contact_status, etc.)
   C. `null` or `0` explicitly — and the spec's score factors only make sense post-stage-assignment, so `0` is correct for a new lead
   D. Other: [please specify]

   **Answer:** A

3. The spec mentions "location scoping enforced via `require-location.ts`." The `@ortho/auth-middleware` package provides `requireLocation()` which reads a single `location_id` from route params or query string. For `GET /leads`, location filtering is a query param but not a strict route guard — agents see only their assigned locations, marketing roles see all. How should this be implemented?
   A. Write a custom `require-location.ts` preHandler in `src/middleware/` that reads `req.user.locations` and scopes DB queries — not using `requireLocation()` from auth-middleware
   B. Use `requireLocation()` from auth-middleware for routes with a `location_id` param (e.g. `GET /leads/:id`); apply custom scoping logic inline in repository methods for list endpoints
   C. Skip `requireLocation()` entirely — apply location scoping in each repository query (`WHERE location_id = ANY($locations)`) based on `req.user.locations`, treating empty array as no filter
   D. Other: [please specify]

   **Answer:** C

4. The spec specifies "paginated (cursor)" for `GET /leads`. What cursor format should be used?
   A. Opaque base64-encoded cursor encoding `(last_seen_id, last_seen_sort_value)` — keyset pagination, works correctly with all sort modes (`score`, `created_at`, `last_activity_at`)
   B. Offset-based (`?page=1&limit=50`) — simpler to implement and sufficient for coordinator list sizes
   C. Cursor encoding only the `id` of the last record (keyset by PK) — simple but breaks sort stability for non-id sort fields
   D. Other: [please specify]

   **Answer:** A

5. Phone numbers must be stored and looked up in normalized E.164 format. Which normalization approach should be used?
   A. `libphonenumber-js` npm package — battle-tested, handles international formats, used in comparable services
   B. Simple regex strip of non-digits + US prefix (`+1`) assumption — sufficient for US-only practices
   C. Twilio's lookup API for normalization at creation time — adds latency but is authoritative
   D. Other: [please specify]

   **Answer:** A

6. Should Lead Service's published event types (`lead.created`, `lead.updated`, `lead.merged`, `lead.archived`, `appointment.updated`) and subscribed event payload types (`lead.stage_changed`, `opt_out.received`, `email.bounced`, etc.) be added to `@ortho/types`, or defined locally in the service?
   A. Add Lead Service-originated event types and payloads to `@ortho/types/src/events.ts` — shared contract for downstream consumers
   B. Define all types locally in `apps/crm/lead/src/` — no changes to `@ortho/types` in this PRD
   C. Add only the subscribed event payload types to `@ortho/types` (since other services publish them); keep Lead Service's own published types local
   D. Other: [please specify]

   **Answer:** A

7. How should the Knex instance and DB connection be set up?
   A. Instantiate Knex directly in `apps/crm/lead/src/db.ts` using `pg` — consistent with how the media service does it (`@ortho/db` is not used as an abstraction layer)
   B. Use an `@ortho/db` package if it exists and exports a factory function
   C. Other: [please specify]

   **Answer:** A

8. The spec says `DELETE /leads/:id` (archive) publishes `lead.archived`. Pipeline Engine also publishes `lead.archived` (which Lead Service subscribes to for clearing the pipeline cache). When a coordinator archives a lead via the HTTP API, should Lead Service:
   A. Publish `lead.archived` from its own route handler AND also react to it via the event worker — the worker's idempotency key `"internal:lead.archived:{lead_id}"` prevents a duplicate timeline entry, and the cache-clear is a no-op if already done
   B. Skip publishing `lead.archived` on HTTP archive — only Pipeline Engine publishes it; Lead Service clears the cache and writes the timeline entry directly in the route handler instead
   C. Publish `lead.archived` from the route handler; the worker only reacts to Pipeline Engine's `lead.archived` events (distinguish origin via metadata)
   D. Other: [please specify]

   **Answer:** A

9. What is the complete list of environment variables the service needs? (Confirm the set below is correct or note additions/removals.)
   Proposed: `DATABASE_URL`, `PORT`, `LOG_LEVEL`, `EVENT_BUS_DRIVER`, `EVENT_BRIDGE_BUS_NAME`, `SQS_QUEUE_URL`, `REDIS_URL`, `EVENT_BUS_CONSUMER_GROUP`, `IDENTITY_JWKS_URL`, `PIPELINE_ENGINE_URL`, `AI_SERVICE_URL`, `SEARCH_SIMILARITY_THRESHOLD`
   A. This list is correct and complete
   B. Add `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (for EventBridge/SQS in production)
   C. Add the above AWS vars AND `SERVICE_AUTH_TOKEN` for internal endpoint protection
   D. Other additions/removals: [please specify]

   **Answer:** C

10. Should there be a `GET /health` endpoint?
    A. Yes — `GET /health` returns `{ ok: true }` with `200`; registered in `allowedPaths` on the auth plugin so it requires no JWT
    B. No health endpoint — ECS uses TCP health checks
    C. Yes — and it should also probe DB connectivity (returns `503` if DB is unreachable)
    D. Other: [please specify]

    **Answer:** A

11. The spec says `GET /leads/duplicates` is "for coordinator review queue." How should it be sorted?
    A. `created_at DESC` (newest duplicates first)
    B. `score DESC` (highest-priority duplicates first — consistent with coordinator queue priority)
    C. The older of the two leads' `created_at ASC` (show the oldest affected lead first)
    D. Other: [please specify]

    **Answer:** A

12. Request body and query string validation — which approach should be used?
    A. TypeBox schemas (`@sinclair/typebox`) registered via `schema: { body: ..., querystring: ... }` on each route — Fastify compiles them to fast-json-stringify validators
    B. Manual validation in route handlers using `TypeCompiler` from TypeBox
    C. Zod schemas
    D. Other: [please specify]

    **Answer:** A

13. What logger service name should be passed to `createLogger`?
    A. `'lead'`
    B. `'crm-lead'`
    C. `'lead-service'`
    D. Other: [please specify]

    **Answer:** B

14. What test coverage is expected?
    A. Unit tests for `score-calculator.ts`, dedup logic, merge logic, contact-status transitions, and all 13 event handlers (mocked DB + MockDriver); integration tests for all route groups and the event worker against a real DB + Redis event bus
    B. Unit tests only (mocked DB, MockDriver) — no integration tests in this PRD
    C. Unit tests for business logic modules; integration tests for DB repositories only (no event bus integration tests)
    D. Other: [please specify]

    **Answer:** A

15. Should this service be implemented in a single Ralph phase, or split into multiple phases?
    A. Single phase — the spec is complete and self-contained; Ralph implements all routes, repositories, worker handlers, and scoring in one pass
    B. Two phases: Phase 1 = core routes + repositories + migrations; Phase 2 = SQS event worker + all handlers
    C. Three phases: Phase 1 = core CRUD routes; Phase 2 = dedup/merge + score calculator; Phase 3 = SQS worker + all 13 handlers
    D. Other: [please specify]

    **Answer:** C

16. The `GET /leads` bulk lookup params — `phones[]`, `emails[]`, `ids[]` — should there be a limit on the array sizes for `phones[]` and `emails[]`, similar to the 500-per-call cap on `ids[]`?
    A. Yes — cap `phones[]` and `emails[]` at 100 per call (phone/email lookups are trigram-indexed, more expensive); return `400` if exceeded
    B. Yes — cap all three at 500 to be consistent with `ids[]`
    C. No — no limit on `phones[]` and `emails[]`; let DB handle it
    D. Other: [please specify]

    **Answer:** A

17. The `tags` table has a unique constraint on `(name, location_id)`. In PostgreSQL, two rows with `(name, NULL)` are treated as distinct (NULLs are not equal in unique indexes). Should global tags (where `location_id IS NULL`) enforce name uniqueness via a partial unique index?
    A. Add a partial unique index `UNIQUE (name) WHERE location_id IS NULL` — enforces one global tag per name
    B. The composite unique index `(name, location_id)` is sufficient; allow multiple global tags with the same name (different semantics per service)
    C. Handle at the application layer — reject `POST /tags` with `location_id: null` if a global tag with that name already exists
    D. Other: [please specify]

    **Answer:** A

18. The merge flow calls Pipeline Engine `POST /pipeline/leads/:id/transition`. Should a timeout on this call cause the merge to fail with a `503`, or should it be retried?
    A. Fail the merge immediately with `503` on Pipeline Engine timeout/error — the client can retry the merge; no partial state is written
    B. Retry up to 3 times with exponential backoff inside the merge handler before failing
    C. Write merge state to DB first, then call Pipeline Engine; if Pipeline Engine fails, roll back the DB transaction
    D. Other: [please specify]

    **Answer:** A

19. Should `GET /leads/:id` include the full list of activities in the response, or should activities be fetched only via the dedicated `GET /leads/:id/activities` endpoint?
    A. `GET /leads/:id` returns the lead record with current tags and current appointments only — no activities embedded; activities require the dedicated endpoint
    B. `GET /leads/:id` includes the last 10 activities inline as a convenience field
    C. `GET /leads/:id` includes all activities (no pagination) — only feasible for leads with limited history
    D. Other: [please specify]

    **Answer:** A

20. For the `lead.converted` event handler — the spec says this is a transient intermediate state immediately overwritten by `lead.stage_changed`. Should the handler write a timeline entry for the conversion event itself?
    A. Yes — write a `lead.converted` activity entry (the spec table says "yes" for timeline)
    B. No — skip the timeline entry since `lead.stage_changed` will arrive immediately and is more meaningful
    C. Write the timeline entry only if `lead.stage_changed` does not arrive within a configurable window (unlikely in practice)
    D. Other: [please specify]

    **Answer:** A
