# Clarifying Questions: Event Bus Adapter

> Original request: Design spec for `packages/@ortho/event-bus` — pluggable event bus with EventBridge (production) and Redis Streams (local/CI) drivers. See `docs/superpowers/specs/2026-03-29-event-bus-adapter-design.md`.

## Questions

1. Can multiple handlers be registered for the same event type via `subscribe()`?
   A. No — second call overwrites the first (one handler per event type)
   B. Yes — all registered handlers are called in series
   C. Yes — all registered handlers are called in parallel (Promise.all)
   D. Other: [please specify]

   **Answer:** B

2. What is the SQS topology for EventBridge in production? Each consumer service needs to receive the same events independently.
   A. Each consumer service has its own dedicated SQS queue + EventBridge rule (fan-out per service)
   B. A single shared SQS queue; all services compete as consumers (work queue, no fan-out)
   C. SNS fan-out → per-service SQS queues (SNS in the middle)
   D. Other: [please specify]

   **Answer:** B

3. What happens to messages that land in the DLQ (both EventBridge/SQS and Redis Streams)?
   A. Alert only — ops team manually inspects and replays
   B. Auto-replay after a cooldown period via a separate worker
   C. Logged + alerting; no automatic replay in scope for this package
   D. Other: [please specify]

   **Answer:** C

4. Does the system require event ordering guarantees within an event type (e.g., stage changes for the same lead must be processed in order)?
   A. No — consumers must be idempotent; ordering is not guaranteed
   B. Yes for Redis Streams (per-stream order preserved); EventBridge/SQS does not need to guarantee it
   C. Yes for both drivers — we need FIFO SQS queues in production
   D. Other: [please specify]

   **Answer:** C

5. Are handlers expected to be idempotent (safe to call more than once for the same event)? SQS delivers at-least-once; Redis Streams can redeliver on restart.
   A. Yes — handler idempotency is the caller's responsibility; the bus doesn't deduplicate
   B. Yes — and the bus should provide a deduplication helper (e.g., check event ID in Redis)
   C. No — the bus must guarantee exactly-once delivery at the infrastructure level
   D. Other: [please specify]

   **Answer:** A

6. Should `OrthoEvent` carry a correlation / trace ID to support distributed tracing across publish → consume hops?
   A. No — not in scope for this package; tracing is handled at the service level
   B. Yes — add an optional `correlation_id` field to `OrthoEvent`
   C. Yes — add `correlation_id` plus `causation_id` (the triggering event's ID)
   D. Other: [please specify]

   **Answer:** C

7. Where are canonical event type strings defined (e.g. `"lead.created"`, `"lead.stage_changed"`)?
   A. In `@ortho/event-bus` itself as an exported `EventType` enum or const map
   B. In `@ortho/types` — event-bus just uses `string`
   C. Informally documented in the spec; no shared enum
   D. Other: [please specify]

   **Answer:** B

8. What should happen if `start()` is called on a bus with zero subscriptions?
   A. No-op / resolves immediately — valid for publisher-only services
   B. Throw an error — `start()` should only be called when there are subscriptions
   C. Log a warning and resolve — treat as a misconfiguration but don't crash
   D. Other: [please specify]

   **Answer:** C

9. What should happen if `subscribe()` is called after `start()` has already been invoked?
   A. Throw an error — subscriptions must be registered before `start()`
   B. Allowed — dynamically spin up a new consumer loop for the new subscription
   C. Silently ignored — late subscriptions receive no messages until restart
   D. Other: [please specify]

   **Answer:** A

10. Should the package expose built-in observability (metrics / structured log events) for publish latency, consumer lag, and processing errors?
    A. No — leave instrumentation entirely to individual services
    B. Yes — emit structured log lines (via `@ortho/logger`) for publish/consume/error events
    C. Yes — structured logs + emit internal counters compatible with Datadog APM
    D. Other: [please specify]

    **Answer:**  A

11. The Redis driver sets `MAXLEN ~ 10000` per stream. What should happen to a slow consumer that falls behind and risks missing trimmed messages?
    A. Acceptable data loss — 10 000 messages per type is sufficient headroom; no special handling
    B. Increase MAXLEN significantly (e.g. 100 000) to reduce risk; still no alerting
    C. Add a consumer-lag check: if pending count exceeds a threshold, log a warning / alert
    D. Other: [please specify]

    **Answer:** C

12. Is schema versioning needed for `OrthoEvent.payload` to support rolling deployments where publisher and consumer may be on different versions?
    A. No — coordinate deployments; consumer-backward-compatible payload changes only
    B. Add an optional `schema_version` field to `OrthoEvent` for future use
    C. Yes — enforce versioning now with a required `schema_version` field and validation
    D. Other: [please specify]

    **Answer:** B
