# Clarifying Questions: Messaging Service

> Original request: Implement the Messaging Service (`apps/platform/messaging`) — a platform-layer SMS/MMS gateway over Twilio handling outbound sends, inbound webhook processing, delivery status tracking, phone number pool management, opt-out registry, inline template rendering, and Redis rate limiting. Based on approved spec: `docs/superpowers/specs/2026-03-25-messaging-service-design.md`.

## Questions

1. What implementation phasing strategy should we follow for the Messaging Service?
	A. Single phase — implement all features (send, webhooks, number pool, opt-outs, rate limiting) in one pass
	B. Two phases — Phase 1: outbound send + number pool + opt-outs; Phase 2: webhooks + rate limiting + events
	C. Three phases — Phase 1: DB + repos + number pool; Phase 2: outbound send flow (opt-out, dedup, render, rate limit, Twilio); Phase 3: inbound/status webhooks + EventBridge events
	D. Other: [please specify]

	**Answer:** C

2. How should the Twilio SDK be integrated for local development and testing?
	A. Use the real Twilio test credentials (test account SID + auth token) that return canned responses without sending real SMS
	B. Create a lightweight in-process mock/stub of the Twilio client that records calls (no HTTP at all)
	C. Use an HTTP interceptor (e.g., `msw` or `nock`) in integration tests to intercept Twilio API calls
	D. Other: [please specify]

   **Answer:** B

3. How should the Redis token bucket rate limiter be implemented?
	A. Inline Lua script string embedded in `rate-limiter.ts`, loaded and executed via `redis.eval()`
	B. Separate `.lua` file loaded at startup and executed via `redis.evalsha()` (SCRIPT LOAD + cached SHA)
	C. Use an existing Redis rate-limiting library (e.g., `rate-limiter-flexible`) that handles token bucket internals
	D. Other: [please specify]

	**Answer:** B

4. How should EventBridge event publishing be handled — specifically, what client/package should the service use?
	A. Use the shared `@ortho/event-bus` package (if it already exists) with typed event helpers
	B. Create a local `events/publisher.ts` that wraps the AWS SDK `EventBridge.putEvents()` directly, with the intent to extract to `@ortho/event-bus` later
	C. Stub/mock EventBridge publishing entirely for now (just log events) and wire up real publishing in a later phase
	D. Use existing shared package `@ortho/event-bus` with typed event helpers, read details in `docs/arch/adr-event-bus.md`

	**Answer:** D

5. What database migration and connection strategy should the service use?
	A. Knex migrations with the shared `@ortho/db` package (if it exists and provides connection/migration utilities)
	B. Knex migrations local to the service (`migrations/` directory), with a local Knex config file
	C. Raw SQL migration files executed by a custom runner
	D. Other: [please specify]

	**Answer:** B

6. How should the Twilio webhook signature validation (`X-Twilio-Signature`) be implemented?
	A. Use the official Twilio SDK's `validateRequest()` / `webhook()` middleware
	B. Implement HMAC-SHA1 validation manually as a pure function (to avoid depending on the full Twilio SDK in the webhook path)
	C. Use the Twilio SDK's `validateRequest()` but wrap it in a Fastify `preHandler` hook
	D. Other: [please specify]

	**Answer:** B

7. Should the service include a Fastify plugin/middleware for shared concerns (auth, request logging, error handling)?
	A. Yes, use `@ortho/auth-middleware` for JWT validation on all routes, and register standard Fastify plugins (CORS, request logging via `@ortho/logger`)
	B. Minimal — only register `@ortho/logger` for structured logging; auth is not needed since this is an internal platform service called only by other services
	C. Auth on external-facing routes only (admin endpoints like `/opt-outs`, `/numbers`), no auth on internal service-to-service routes (`/messages/send`)
	D. Other: [please specify]

	**Answer:** C, register `@ortho/logger` for structured logging

8. How should the `messaging_numbers` phone number pool be seeded for development and testing?
	A. Seed script that inserts test numbers into the DB (run manually or as part of dev setup)
	B. The `POST /numbers` provision endpoint is sufficient — just call it during test setup
	C. Factory functions in `@ortho/testing` that create number records on demand in tests
	D. Other: [please specify]

	**Answer:** A

9. What level of observability should be included in the initial implementation?
	A. Structured logging only (Pino via `@ortho/logger`) — request/response logs, Twilio call logs, error logs
	B. Structured logging + Datadog custom metrics (send latency, rate limit hits, opt-out checks, Twilio error rates)
	C. Structured logging + basic health check endpoint (`GET /health`) — metrics deferred to a later phase
	D. Other: [please specify]

	**Answer:** C

10. How should the `POST /messages/send` endpoint handle Twilio API errors (e.g., invalid number, Twilio outage)?
	A. Catch Twilio errors, insert the message record with `status: 'failed'` and the Twilio error code/message, return `500` to the caller
	B. Catch Twilio errors, insert with `status: 'failed'`, publish `message.failed` event immediately, return `500`
	C. Catch Twilio errors, insert with `status: 'failed'`, return a structured error response (e.g., `502` with Twilio error details) so callers can distinguish Twilio failures from validation errors
	D. Other: [please specify]

	**Answer:** C

11. Should the `GET /messages` list endpoint support cursor-based pagination or offset-based pagination?
	A. Cursor-based pagination (keyset pagination using `created_at` + `id`) — better for large datasets and consistent with real-time inserts
	B. Offset-based pagination (`limit` + `offset`) — simpler to implement, sufficient for expected query patterns
	C. Both — cursor-based as default, offset as optional fallback
	D. Other: [please specify]

	**Answer:** A

12. How should the inbound webhook respond to Twilio when processing fails (e.g., DB insert fails after signature validation)?
	A. Return `500` — Twilio will retry the webhook (up to its retry policy)
	B. Return `200` always after signature validation passes (best-effort processing; log errors but never trigger Twilio retries to avoid duplicate processing)
	C. Return `200` for non-critical failures (e.g., EventBridge publish fails), `500` for critical failures (e.g., DB insert fails) so the message is retried
	D. Other: [please specify]

	**Answer:** A

13. What testing infrastructure should be set up for integration tests requiring Postgres and Redis?
	A. Docker Compose file local to the service (`docker-compose.test.yml`) with Postgres + Redis containers, started before tests
	B. Rely on a shared/project-level Docker Compose that other services also use
	C. Use Testcontainers (via `testcontainers` npm package) to spin up Postgres + Redis per test suite
	D. Other: [please specify]

	**Answer:** B
