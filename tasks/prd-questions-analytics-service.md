# Clarifying Questions: Analytics Service

> Original request: Implement the Analytics Service per the approved design spec at `docs/superpowers/specs/2026-03-25-analytics-service-design.md`

## Questions

1. The spec says "Thirteen typed handlers" (Section 4) but the handler table lists only 12 events and the `handlers/` file tree lists 12 files. `metrics_campaigns_daily` has a `delivered` column — which event populates it and which handler is the missing 13th?
   A. There is a `campaign.delivered` event (published by Campaign Service when SendGrid confirms delivery) that should be added to the table — add a 13th handler file `campaign-delivered.ts`
   B. The `delivered` column is populated by `CampaignSentHandler` (sent = delivered optimistically) — no 13th handler, "thirteen" is a copy error; the column should be removed or renamed `sent`
   C. The `delivered` column is populated by `MessageDeliveredHandler` when `entity_type = 'campaign'` — route through existing handler, no new file
   D. Other: [please specify]

   **Answer:** A

2. The file structure in Section 8 lists 6 metric route files (`leads.ts`, `pipeline.ts`, `conversions.ts`, `messages.ts`, `ad-spend.ts`, `campaigns.ts`) but Section 5.2 defines 8 named endpoints — `referrals` and `coordinators` are missing. Should `routes/metrics/referrals.ts` and `routes/metrics/coordinators.ts` be created?
   A. Yes — both files are missing from the Section 8 tree by oversight; create both
   B. Yes for `referrals.ts`; `coordinators` is out of scope for this iteration
   C. No — both endpoints will be served from `query.ts` (generic DSL) for now; the named routes are future work
   D. Other: [please specify]

   **Answer:** A

3. The SQS consumer polls for messages, but the spec does not define the batch size or polling interval. What are the expected values?
   A. Batch size 10 (SQS max per receive), long-polling with 20s wait time — standard pattern used by Automation Engine
   B. Batch size 1, short-polling — simplest implementation, revisit under load
   C. Batch size 10, short-polling with 1s interval
   D. Coordinate with package `packages/@ortho/event-bus` capabilities, batch size 10 and 10s interval seems to be reasonable

   **Answer:** D

4. For concurrent SQS processing: should messages within a batch be processed sequentially (one at a time) or in parallel (all 10 concurrently with `Promise.all`)?
   A. Sequentially — simpler, avoids DB connection pool exhaustion at low volume
   B. In parallel (`Promise.all` on the batch) — higher throughput, connection pool must be sized accordingly
   C. Parallel with a concurrency cap (e.g. `p-limit(5)`)
   D. Other: [please specify]

   **Answer:** C

5. Section 3.1 says the raw event log "enables rollup re-derivation if a bug corrupts counters," but no re-derivation mechanism is specified. What is in scope for this iteration?
   A. Nothing — re-derivation is mentioned as a data recovery capability, but no script or endpoint is required in this iteration
   B. A one-off Node.js script (`scripts/recompute-rollups.ts`) that can be run manually in production
   C. An admin-only REST endpoint (`POST /analytics/admin/recompute`) protected by a separate role
   D. An admin-only REST endpoint (`POST /analytics/admin/recompute`) protected by a secret key provided in payload (simpler than having a separate role).

   **Answer:** D

6. The generic `POST /analytics/query` endpoint queries raw `analytics_events` and is capped at 10,000 rows. Should it have additional access controls or rate limiting beyond JWT/API-key auth?
   A. No additional controls — the 10,000-row cap is sufficient; the endpoint is internal-only (Reporting Service + authorized staff)
   B. Restrict to service accounts only (`ak_`-prefixed keys) — no end-user JWTs allowed on this endpoint
   C. Rate-limit per caller (e.g. 10 req/min per JWT subject) using a Fastify rate-limit plugin
   D. Both B and C
   E. Other: [please specify]

   **Answer:** C

7. Should the named metric endpoints (`GET /analytics/metrics/*`) paginate their responses, or return the full dataset for the requested period?
   A. No pagination — the Reporting Service always queries bounded periods (≤31 days daily, ≤12 months monthly); full dataset is fine
   B. Cursor-based pagination with a configurable `limit` query param (default 1,000)
   C. Offset-based pagination (`page` + `page_size`)
   D. Offset-based pagination (`page` + `page_size`), page_size default and max to 1,000

   **Answer:**  D

8. `StageChangedHandler` writes to two rollup tables (`metrics_pipeline_daily` + `metrics_coordinators_daily`) in one transaction. The idempotency rule (Section 6.1) says "if the raw insert is skipped, the rollup increment is also skipped." Does this apply to **both** rollup writes in this handler?
   A. Yes — if `analytics_events` insert is a no-op (duplicate `event_id`), skip both rollup updates
   B. Yes for `metrics_pipeline_daily`, but `metrics_coordinators_daily` follows the same relaxed rule as `AdSpendSyncedHandler` (always upsert)
   C. The spec is clear — both rollup writes are skipped on duplicate; no ambiguity
   D. Other: [please specify]

   **Answer:** C

9. `ReferralConvertedHandler` writes to both `metrics_referrals_daily` and `metrics_conversions_daily` (channel=`referral`). Does the same dual-skip idempotency apply here?
   A. Yes — both rollup writes are skipped if `analytics_events` insert is a no-op
   B. Only `metrics_referrals_daily` is skipped; `metrics_conversions_daily` always upserts to match ad-spend pattern
   C. The spec is clear — skip both on duplicate
   D. Other: [please specify]

   **Answer:** C

10. How should the service handle a DB transaction failure during event processing (e.g. a transient Postgres timeout)?
    A. Let the SQS visibility timeout expire — the message is automatically re-delivered (up to max receive count of 3), then goes to DLQ
    B. Catch the error, explicitly release the SQS message (change visibility to 0) for immediate retry, and log at `error` level
    C. Catch the error, log it, and manually acknowledge (delete) the message to avoid DLQ noise — transient DB failures are not a signal worth alerting on
    D. Other: [please specify]

    **Answer:** A

11. How does the SQS consumer lifecycle integrate with Fastify? Should the consumer start/stop with the HTTP server?
    A. Consumer starts in the Fastify `onReady` hook and stops in the `onClose` hook — tightly coupled to server lifecycle
    B. Consumer is a standalone process entry point (`src/worker.ts`) — separate from the HTTP server, deployed as a second ECS task
    C. Consumer starts independently in `index.ts` (not via Fastify hooks) — server and consumer boot concurrently, both in the same process
    D. Both B & C - `src/worker.ts`, can be started as independent standalone process, starts independetly of Fastify in `index.ts`

    **Answer:** D

12. What environment variables does this service require? The spec mentions `ANALYTICS_API_KEY` (used by Reporting Service), but what does the Analytics Service itself need configured?
    A. Standard set: `DATABASE_URL`, `SQS_QUEUE_URL`, `IDENTITY_SERVICE_URL`, `PORT`, `LOG_LEVEL`, `REDIS_URL` (for BullMQ partition job)
    B. Same as A, plus `API_KEY_CACHE_TTL_SECONDS` (override the 60s default from Section 5.4)
    C. Same as A, plus `SQS_POLLING_INTERVAL_MS` and `SQS_BATCH_SIZE` as runtime-configurable values
    D. Same as C, plus whatever is required to configure @ortho/event-bus package

    **Answer:**  D

13. Should the service expose a health/readiness endpoint for ECS health checks?
    A. Yes — `GET /health` returning `200 { status: "ok" }` (liveness only, no dependency checks)
    B. Yes — `GET /health` (liveness) + `GET /ready` (checks DB + SQS reachability)
    C. No — ECS task health is managed at the load balancer level; the service doesn't need its own endpoint
    D. Other: [please specify]

    **Answer:** B

14. What is the expected test strategy for this service?
    A. Unit tests for handlers (mock DB), unit tests for `query-builder.ts` (SQL generation), integration test for the SQS→handler→DB path using a real test DB
    B. Unit tests only (no integration tests in this iteration) — handlers and query builder tested with mocks
    C. Integration tests only — spin up a real Postgres instance in Vitest, no mocks for handlers
    D. Other: [please specify]

    **Answer:** A

15. The BullMQ partition maintenance job (Section 6.3) requires Redis. Should the Analytics Service use its own dedicated Redis instance, or share with the Automation Engine / Nurturing Engine?
    A. Share the existing Redis instance — use a separate BullMQ queue name prefix (`analytics:`) to avoid key collisions
    B. Dedicated Redis instance for Analytics — partition maintenance is critical enough to warrant isolation
    C. No preference — `REDIS_URL` env var will be environment-specific; the service doesn't need to know
    D. Other: [please specify]

    **Answer:** A + C

16. The spec says `campaign_name` in `metrics_ad_spend_daily` is a "display hint" and warns that Reporting Service must always group by `campaign_id`. Should this constraint be enforced or documented anywhere in the Analytics Service itself?
    A. No enforcement needed — this is a Reporting Service concern; Analytics just stores what it receives
    B. Add a comment in `ad-spend-synced.ts` and/or the migration file explaining the display-hint semantics
    C. Expose a dedicated `GET /analytics/metrics/ad-spend/campaigns` sub-endpoint that always groups by `campaign_id`, preventing misuse
    D. Other: [please specify]

    **Answer:** B + C

## Follow-up Questions

17. **Answer D to Q3 says to coordinate with `@ortho/event-bus` capabilities, but the spec defines a custom `sqs-consumer.ts` in `src/services/`.** The `@ortho/event-bus` package provides `EventBridgeDriver` which already handles SQS long-polling, message deletion, and retry — the same responsibilities the spec assigns to `sqs-consumer.ts`. Should the Analytics Service use `@ortho/event-bus` (`bus.subscribe()` + `bus.start()`) and drop the custom SQS consumer entirely, or keep `sqs-consumer.ts` and call the event-bus `SQS_QUEUE_URL` directly without going through the package?
    A. Use `@ortho/event-bus` fully — replace `sqs-consumer.ts` with `bus.subscribe()` / `bus.start()` pattern; the file structure in Section 8 is updated accordingly (no `sqs-consumer.ts`, no `event-router.ts` — routing is handled via individual `bus.subscribe()` calls in `index.ts`)
    B. Keep `sqs-consumer.ts` as a thin wrapper that calls `createEventBus()` internally, so the event routing (switch on `event_type`) stays in `event-router.ts` as spec'd (rely on `@ortho/event-bus`)
    C. Keep a custom SQS consumer (`sqs-consumer.ts`) that does NOT use `@ortho/event-bus` — the package is only used by services that also need to publish events
    D. Other: [please specify]

    **Answer:** B

18. **Dedup `event_id` source when using `@ortho/event-bus`.** Section 6.1 says `event_id` is "sourced from the EventBridge message ID." When `@ortho/event-bus` delivers an `OrthoEvent` to a handler, the SQS message ID is consumed internally by the driver — it is not exposed to the handler. The `OrthoEvent` type (`entity_id`, `entity_type`, `event_type`, `payload`, optional `correlation_id`) has no `event_id` or SQS message ID field. How should Analytics Service obtain a stable dedup key for the `analytics_events.event_id` column?
    A. Use `OrthoEvent.correlation_id` as the dedup key — publishers are expected to set it to a stable UUID per event; `correlation_id` is unique per publish call
    B. Publishers embed a dedicated `payload.event_id` field (a UUID set at publish time); handlers read `event.payload.event_id`
    C. Add `event_id` to the `OrthoEvent` type in `@ortho/event-bus` (requires amending the package); publishers always set it; handlers use `event.event_id`
    D. Derive a synthetic dedup key from `(event_type + entity_id + occurred_at)` rounded to the nearest second — good enough for at-least-once dedup in practice
    E. Other: [please specify]

    **Answer:** C

19. **`campaign.delivered` handler specifics (from Q1 Answer A).** A 13th handler `campaign-delivered.ts` is added for a `campaign.delivered` event. What service publishes this event and what is the payload shape and rollup target?
    A. Campaign Service publishes `campaign.delivered` via a SendGrid delivery webhook; payload: `{ campaign_id, location_id, recipient_count }`; handler increments `metrics_campaigns_daily.delivered` by `recipient_count`
    B. Campaign Service publishes `campaign.delivered` per-recipient (one event per successful delivery); payload: `{ campaign_id, location_id }`; handler increments `metrics_campaigns_daily.delivered` by 1
    C. Email Service publishes `campaign.delivered` when it receives a SendGrid delivery webhook for a campaign email; payload: `{ campaign_id, location_id }`; increments `metrics_campaigns_daily.delivered` by 1
    D. Other: [please specify]

    **Answer:** A

20. **Pagination response shape (from Q7 Answer D).** Offset-based pagination with default/max 1,000 rows is added to the named metric endpoints. What does the paginated response envelope look like?
    A. `{ period, granularity, data: [...], total: N, page: N, page_size: N, total_pages: N }`
    B. `{ period, granularity, data: [...], meta: { total, page, page_size, total_pages } }` — metadata nested under `meta` to keep the top-level shape clean
    C. `{ period, granularity, data: [...], total: N }` — only `total` is added; the caller tracks `page` / `page_size` themselves
    D. Other: [please specify]

    **Answer:** B

21. **Rate-limit scope (from Q6 Answer C).** The rate limit (10 req/min per caller JWT subject) applies to:
    A. `POST /analytics/query` only — the named metric endpoints are not rate-limited
    B. All endpoints under `/analytics/` including named metric endpoints
    C. `POST /analytics/query` at 10 req/min; named metric endpoints at a higher limit (e.g. 60 req/min)
    D. Other: [please specify]

    **Answer:** C

22. **Rate limiting for API key callers (from Q6 Answer C).** API key (`ak_`-prefixed) callers (e.g. Reporting Service) don't have a JWT `sub` to key off. How should rate limiting handle them?
    A. Exempt API key callers entirely — trusted service-to-service calls are not rate-limited
    B. Apply the same rate limit but bucket by `SHA256(key)` — same limit, different bucket key
    C. Higher rate limit for API key callers (e.g. 100 req/min) to support Reporting Service batch queries without throttling
    D. Other: [please specify]

    **Answer:** C

23. **Admin recompute endpoint model (from Q5 Answer D).** `POST /analytics/admin/recompute` accepts a secret key. What is its execution model and scope?
    A. Synchronous; body: `{ secret, table, date_range: { from, to } }`; HTTP waits; returns row counts on completion; max range constrained to 7 days to prevent gateway timeouts
    B. Asynchronous; body: `{ secret, table, date_range }`; enqueues a BullMQ job; returns `{ job_id }` immediately; caller polls `GET /analytics/admin/recompute/:job_id`
    C. Synchronous; no date range filter — always recomputes from the entire raw event log (fine given row volumes at launch)
    D. As B, but secret should be passed in headers. Header name `X-Admin-Key`

    **Answer:**  D

24. **Parallel concurrency cap value (from Q4 Answer C).** What is the specific concurrency limit for parallel event processing within a batch?
    A. 3 — conservative; keeps DB connection pool usage low during bursts
    B. 5 — balanced default; consistent with the example given in Q4
    C. Configurable via env var `SQS_CONCURRENCY` (default 5) — gives ops flexibility without code changes
    D. Other: [please specify]

    **Answer:** C
