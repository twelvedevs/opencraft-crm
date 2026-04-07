# Clarifying Questions: Conversation Service

> Original request: Implement the Conversation Service as specified in `docs/superpowers/specs/2026-03-25-conversation-service-design.md` — a product-layer SMS inbox bridging the Messaging Service and Lead records, with coordinator workflow, AI features, AI Agent autonomous mode, BullMQ workers, and EventBridge integration.

---

## Questions

### Package & Runtime

1. What port should the Conversation Service listen on?
   A. Driven by `PORT` env var with a hardcoded default (e.g. `3006`)
   B. `PORT` env var only — no hardcoded default; service fails to start if unset
   C. Other: Driven by `PORT` env var, default to 3006

   **Answer:** C

2. What is the npm package name for this service?
   A. `@ortho/conversation`
   B. `@crm/conversation`
   C. `conversation-service` (unscoped)
   D. Other: [please specify]

   **Answer:** B

---

### Database & Migrations

3. How should the Knex pool be configured to use the `crm_conversations` schema?
   A. Set `searchPath: 'crm_conversations'` in the Knex pool config so queries use unqualified table names (`conversations`, `conversation_messages`, etc.)
   B. Prefix every table reference with the schema (`crm_conversations.conversations`)
   C. Other: [please specify]

   **Answer:** A

4. Should the service configure Knex directly (as Pipeline Engine does), or use a shared `@ortho/db` package?
   A. Configure Knex directly in the service — `@ortho/db` doesn't exist yet; use `knex` + `pg` directly
   B. Use `@ortho/db` if it exists, otherwise configure directly
   C. Other: [please specify]

   **Answer:** A

5. What migration file naming convention should be used?
   A. Timestamp prefix: `20260325000000_create_conversations.ts`
   B. Sequential: `001_create_conversations.ts`
   C. Whatever Knex CLI generates by default
   D. Other: [please specify]

   **Answer:** A

---

### Auth & Middleware

6. Should the Conversation Service use `@ortho/auth-middleware` directly, or is it behind the CRM API Gateway which handles all RBAC?
   A. Use `@ortho/auth-middleware` directly — the service validates JWTs itself and enforces RBAC per route
   B. API key / shared secret only — the CRM API Gateway authenticates callers; this service validates a static header
   C. Other: [please specify]

   **Answer:** B

7. The spec says bulk SMS (`POST /bulk-sends`) is accessible to `call_center_manager` (own location) and `marketing_manager` (all locations). However `ROLE_PERMISSIONS` in `adr-auth-middleware.md` does not list `call_center_manager` with `campaigns:write` or any bulk-send-related permission. How should the bulk-sends route be guarded?
   A. Use `requirePermission('conversations:write')` — `call_center_manager` has this permission and it's the closest fit for SMS operations
   B. Use `requireRole(['call_center_manager', 'marketing_manager', 'super_admin'])` — bypass the permission map and gate directly by role
   C. Add a new permission `bulk-sms:write` to `ROLE_PERMISSIONS` in `@ortho/auth-middleware` as part of this service's implementation
   D. Other: [please specify]

   **Answer:** B + C

8. `PATCH /conversations/:id` has mixed role requirements — most fields (`assigned_to`, `escalated`, `status`, `agent_mode_active: false`) can be set by any coordinator role, but `agent_mode_active: true` requires `marketing_manager` only. How should this be enforced?
   A. One endpoint guarded by `requirePermission('conversations:write')`; the handler checks `req.user.role === 'marketing_manager'` for the `agent_mode_active: true` case and returns `403` if not met
   B. Split into two endpoints — `PATCH /conversations/:id` for general coordinator fields, `POST /conversations/:id/agent-mode` for agent re-enable (guarded by `requireRole(['marketing_manager', 'super_admin'])`)
   C. Other: [please specify]

   **Answer:**  A

9. `GET /conversations` uses `?location_id=uuid` as a filter. The `requireLocation()` guard reads `location_id` from query string and enforces access. For a `call_center_agent` who omits `location_id`, should the service:
   A. Require explicit `location_id` query param — return `403` if missing (the guard handles this automatically since no `location_id` is found)
   B. Auto-scope to the agent's home location from `req.user.locations[0]` when `location_id` is omitted
   C. Other: [please specify]

   **Answer:**  A

---

### Event Bus Integration

10. What `EVENT_BUS_CONSUMER_GROUP` value should the Conversation Service use?
    A. `"conversation"` — matches the service name
    B. `"crm-conversation"` — scoped to distinguish it from any platform-layer service named similarly
    C. Other: [please specify]

    **Answer:** B

11. The service subscribes to 3 event types (`inbound_message.received`, `message.delivered`, `message.failed`) and publishes 1 (`message.received`). Should these use the same `EventBus` instance?
    A. Yes — one `EventBus` instance handles both subscribe and publish; call `bus.subscribe(...)` × 3 before `bus.start()`, then use `bus.publish(...)` in handler code
    B. Two separate instances — one for subscribing (consumer), one for publishing (producer)
    C. Other: [please specify]

    **Answer:**  A

12. Following the Pipeline Engine precedent (Q10 answer: `event_id` added to `OrthoEvent`): should `event_id` be included in the `message.received` published event envelope?
    A. Yes — include `event_id: randomUUID()` on the envelope, consistent with all other published events
    B. No — omit `event_id`; only `correlation_id` and `causation_id` are needed
    C. Other: [please specify]

    **Answer:**  A

13. How should `correlation_id` be populated on the `message.received` event published during inbound message processing?
    A. Generate a fresh `randomUUID()` at publish time — the inbound path starts from an EventBridge event, not an HTTP request
    B. Forward the `correlation_id` from the incoming `inbound_message.received` event envelope to chain the trace
    C. Leave `correlation_id` undefined on published events
    D. Other: [please specify]

    **Answer:**  B

14. Should all published events include `schema_version: '1.0'`?
    A. Yes — always set `schema_version: '1.0'` on `message.received` events
    B. No — omit `schema_version` until a versioning story is established
    C. Other: [please specify]

    **Answer:** A

---

### BullMQ & Redis

15. Should BullMQ use the same `REDIS_URL` env var as the `RedisStreamsDriver` event bus, or a separate variable?
    A. Same `REDIS_URL` — one Redis instance for both event bus streams and BullMQ queues
    B. Separate `BULLMQ_REDIS_URL` — allows the two to be on different Redis instances
    C. Other: [please specify]

    **Answer:** B

16. Should BullMQ queue names be plain (as in the spec) or prefixed with the service name?
    A. Plain: `ai-agent-reply`, `scheduled-send`, `bulk-send`
    B. Prefixed: `conversation:ai-agent-reply`, `conversation:scheduled-send`, `conversation:bulk-send`
    C. Other: [please specify]

    **Answer:** B

17. What concurrency should each BullMQ worker run at?
    A. `ai-agent-reply`: 5, `scheduled-send`: 10, `bulk-send`: 1 (bulk runs are CPU/network-intensive)
    B. All workers: `concurrency: 1` (simplest, correct-by-default for v1)
    C. Driven by env vars (`AI_AGENT_CONCURRENCY`, etc.) with sensible defaults
    D. Other: [please specify]

    **Answer:** C

18. How should BullMQ workers participate in graceful shutdown (SIGTERM)?
    A. Call `worker.close()` on each worker in the SIGTERM handler — BullMQ drains in-flight jobs before closing
    B. Call `worker.pause(true)` (drain) then `worker.close()`
    C. Let the process exit; BullMQ's at-least-once semantics will re-queue any in-flight jobs on restart
    D. Other: [please specify]

    **Answer:** B

---

### Inter-Service HTTP Calls

19. What HTTP client should be used for service-to-service calls (Messaging Service, Lead Service, AI Service, Audience Engine, Notification Service)?
    A. Native `fetch` (Node.js 24 built-in) — no extra dependency
    B. `undici` — better connection pooling and TypeScript ergonomics
    C. A thin shared wrapper that handles base URL + auth headers — implement locally in the service
    D. Other: [please specify]

    **Answer:**  C

20. How should inter-service base URLs be configured?
    A. Separate env var per downstream service: `MESSAGING_SERVICE_URL`, `LEAD_SERVICE_URL`, `AI_SERVICE_URL`, `AUDIENCE_ENGINE_URL`, `NOTIFICATION_SERVICE_URL`
    B. A single `SERVICES_BASE_URL` with known path prefixes (e.g. `/messages`, `/leads`, `/ai`, `/audiences`, `/notifications`)
    C. Other: [please specify]

    **Answer:** A

---

### `@ortho/types` — Event Payload Types

21. The `message.received` event published by this service needs a typed payload. `@ortho/types/src/events.ts` does not currently have `MessageReceivedPayload` or `MessageReceivedEvent`. Should adding these types be in-scope for this implementation?
    A. Yes — add `MessageReceivedPayload` and `MessageReceivedEvent` to `packages/@ortho/types/src/events.ts` as part of this service's implementation
    B. No — the Conversation Service casts the payload inline; types are added as a separate task
    C. Other: [please specify]

    **Answer:** A

---

### Request Validation & Error Handling

22. Should TypeBox be used for all request body and response schemas?
    A. Full TypeBox schemas for all request/response shapes — use `@sinclair/typebox` + Fastify's built-in schema validation
    B. TypeBox for request validation only; responses are typed by TypeScript but not schema-validated
    C. Other: [please specify]

    **Answer:** A

23. For unexpected server-side failures (DB error, unhandled exception), what HTTP response should be returned?
    A. `500 { "error": "internal_error" }` — consistent with other services in the spec
    B. Let Fastify's default error handler return its standard JSON shape
    C. Other: [please specify]

    **Answer:** A

---

### Route Structure

24. How should the Fastify route prefix be structured?
    A. Register all routes under a `/conversations` Fastify plugin prefix — service sub-routes become `/conversations/:id/messages`, etc.
    B. No prefix in the service itself — the CRM API Gateway handles the `/conversations` prefix; service routes start at `/:id/messages`
    C. Other: [please specify]

    **Answer:** A

---

### Testing

25. What library should be used to mock HTTP calls to downstream services in integration tests (Messaging Service, Lead Service, AI Service, etc.)?
    A. `nock` — intercept Node.js `http`/`https` at the module level
    B. `msw` (Mock Service Worker) — intercept via service worker / `node` handler
    C. `undici` `MockAgent` — intercept at the fetch/undici level
    D. Other: [please specify]

    **Answer:** A

26. How should the integration test database be set up and torn down?
    A. Each test file spins up its own schema via Knex migrations in `beforeAll` and drops it in `afterAll` — matches Pipeline Engine pattern
    B. Tests run against a fixed local Postgres DB seeded by `docker-compose`; truncate tables between tests
    C. Use `@ortho/testing` fixtures if available
    D. Other: [please specify]

    **Answer:** A

27. For BullMQ integration tests (scheduled-send, ai-agent-reply, bulk-send workers), how should the worker be triggered?
    A. Use a real BullMQ worker connected to a local Redis (via `docker-compose`); enqueue the job and `await` the worker's completion event
    B. Call the worker's internal handler function directly — bypass the BullMQ queue and just test the business logic
    C. Other: [please specify]

    **Answer:** B

28. Should contract tests (event payload shape assertions for `message.received`) live in a dedicated `test/contract/` folder, as established by the Pipeline Engine?
    A. Yes — `test/contract/` folder, consistent with Pipeline Engine pattern
    B. Co-located in integration test files — assert payload shape at the point the event is published
    C. Other: [please specify]

    **Answer:** A

---

### Logging

29. What structured fields should be bound in the child logger for each inbound HTTP request?
    A. `{ requestId, conversationId, locationId }` — bind all available IDs as they become known
    B. `{ requestId }` at handler entry; add `conversationId` / `locationId` in the service layer as they resolve
    C. Follow the pattern from `adr-logger.md` exactly: `{ requestId, locationId }` at handler entry only
    D. Other: [please specify]

    **Answer:** A

30. What structured fields should be bound in the child logger for each BullMQ worker job?
    A. `{ jobId, conversationId }` bound at job start; add `leadId`, `messagingMessageId` as they resolve
    B. `{ jobId }` only — other IDs logged inline per log statement
    C. Other: [please specify]

    **Answer:** A

---

### AI Service Prompts

31. The spec requires 4 prompts to be registered in the AI Service prompt registry (`conversation-reply-drafts`, `conversation-summary`, `conversation-objection-handling`, `conversation-agent-reply`). Is registering these prompts in-scope for this service's implementation?
    A. Yes — add the 4 prompt definitions to `apps/platform/ai/src/prompts/` as part of this implementation
    B. No — prompt registration is a separate task owned by the AI Service; this implementation documents the required prompt IDs but does not create them
    C. Other: [please specify]

    **Answer:** A
