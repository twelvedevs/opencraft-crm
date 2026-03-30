# Clarifying Questions: Notification Service

> Original request: Design and implement the platform-layer Notification Service (`apps/platform/notification`) — real-time in-app notifications via SSE, Redis pub/sub fan-out, per-user read state, and 7-day persistence, as specified in `docs/superpowers/specs/2026-03-25-notification-service-design.md`.

## Questions

1. The spec says SSE clients authenticate via `Authorization: Bearer <token>` header, but the browser's native `EventSource` API cannot set custom headers. How should the SSE stream endpoint handle authentication?
	- A. Query parameter token (`?token=<jwt>`) — simple but token appears in server logs/URLs
	- B. Secure `HttpOnly` cookie — set by Identity Service at login, transparent to the browser
	- C. Fetch-based SSE polyfill (e.g. `@microsoft/fetch-event-source`) — supports custom headers, requires a JS library
	- D. Other: [please specify]

	**Answer:** C

2. The spec defines channel access control for `location:*`, `user:*`, and `global:*` prefixes. Should the service enforce a strict allowlist of these prefixes, or accept any arbitrary channel string (with access control only applied to recognized patterns)?
	- A. Strict allowlist — reject channels that don't match a known prefix pattern (400)
	- B. Accept any string, apply access control only to recognized prefixes, open access for unrecognized ones
	- C. Accept any string, deny access to unrecognized channel prefixes by default (fail-closed)
	- D. Other: [please specify]

	**Answer:** A

3. If a client reconnects with a `Last-Event-ID` that is very old (e.g., from 5 days ago), the replay query could return thousands of notifications. Should there be a cap on replay volume?
	- A. No cap — replay everything since `Last-Event-ID`, regardless of count
	- B. Cap by count (e.g., last 200 notifications since `Last-Event-ID`)
	- C. Cap by time window (e.g., only replay last 24 hours regardless of `Last-Event-ID`)
	- D. Cap by count, and include a `replay-truncated` SSE event so the client knows it missed some
	- E. Other: [please specify]

	**Answer:** D

4. The spec includes `GET /notifications` for history but no dedicated endpoint for unread count. How does the frontend badge/indicator get its unread count?
	A. It calls `GET /notifications?unread=true&limit=1` and uses total count from a response header — needs a `X-Total-Count` header added to the spec
	B. Unread count is included in a separate `GET /notifications/unread-count?channels=...` endpoint (not currently in spec)
	C. The frontend derives it client-side by tracking what it has already seen via the SSE stream
	D. The `GET /notifications` response should include a `total_unread` field in the root object
	E. Other: [please specify]

	**Answer:** A

5. Should the service validate and enforce the `payload` 4KB limit by byte length of the serialized JSON, or by some other measure?
	A. Byte length of the serialized JSON string (UTF-8 encoded)
	B. Character count of the JSON string
	C. Key/value depth or structure restrictions (no nesting beyond N levels)
	D. No enforcement at the service layer — caller's responsibility

	**Answer:** A

6. Are there limits on concurrent SSE connections per user or globally per instance? A user with many open browser tabs will open multiple SSE connections.
	A. No limits — accept all connections, rely on ECS autoscaling
	B. Per-user connection limit (e.g., max 10 simultaneous SSE connections per user_id)
	C. Global per-instance limit only (controlled by OS/Fastify connection limits)
	D. Per-user soft limit with a warning event sent to the oldest connection before closing it
	E. Other: [please specify]

	**Answer:** D

7. The service-to-service JWT used for `POST /notifications/publish` — what is the intended issuance and validation mechanism?
	A. Shared secret (HMAC-signed JWT) — secret stored in AWS Secrets Manager, all platform services share it
	B. Per-service RSA/EC key pair — each calling service has its own signed JWT, Notification Service validates against known public keys
	C. Identity Service issues short-lived service tokens — callers exchange their service identity for a JWT via Identity Service
	D. mTLS between services in the VPC — no JWT needed for publish endpoint
	E. Other: [please specify]

	**Answer:** A

8. Should `POST /notifications/publish` have rate limiting to protect against a misbehaving product service flooding the system?
	A. No rate limiting — all callers are trusted internal services
	B. Per-calling-service rate limit (identified by JWT `sub` claim)
	C. Per-channel rate limit (e.g., max 100 publishes/minute per channel)
	D. Both per-service and per-channel limits
	E. Other: [please specify]

	**Answer:** C

9. When Redis becomes unavailable, what should happen to in-flight operations?
	A. `POST /notifications/publish` fails with 503 after DB write succeeds — partial success is acceptable, notification is persisted but not fanned out
	B. `POST /notifications/publish` rolls back the DB write and returns 503 — atomic: both succeed or both fail
	C. `POST /notifications/publish` succeeds (DB write only), and a BullMQ job retries the Redis publish — eventual fan-out
	D. Existing SSE connections stay open but receive no new events; reconnects fail until Redis recovers
	E. Other: [please specify]

	**Answer:** C

10. The spec mentions the SSE Manager excludes the originating connection when broadcasting read-sync events ("excluding the originating connection via connection ID"). How is the originating connection identified across the HTTP request and the SSE channel?
	A. The read request (`POST /:id/read`) includes a `X-Connection-ID` header set by the client
	B. The SSE connection ID is stored server-side per user and passed in the Redis pub/sub message
	C. No exclusion needed — the client can safely ignore a read event for a notification it already marked read
	D. Other: [please specify]

	**Answer:** A + B

11. Is there a plan for a shared frontend React hook or component for the notification bell/feed UI, or is the CRM Web App responsible for building its own?
	A. A `@platform/notification-ui` React package will be built alongside this service (similar to `@platform/template-ui`)
	B. The CRM Web App builds its own UI — the service only provides the API
	C. A shared hook (e.g., `useNotifications`) will live in `@platform/notification-ui` but no pre-built UI components
	D. Other: [please specify]

	**Answer:** A, but for later phases

12. Should the daily BullMQ cleanup job run at a specific time (e.g., 2am UTC) or just on a fixed interval (e.g., every 24 hours from service start)?
	A. Fixed cron schedule (specific UTC time) — predictable, easier to reason about DB load
	B. Fixed interval from service start — simpler, but timing drifts if service restarts
	C. Only one instance should run the job (BullMQ handles deduplication across instances) — timing is secondary

	**Answer:** A

13. Are there any observability requirements beyond the Datadog dashboard — e.g., specific alerts, SLOs, or tracing requirements for the SSE stream health?
	A. No additional requirements beyond the existing Datadog APM setup
	B. An alert if the SSE fan-out lag (Redis publish → client delivery) exceeds a threshold
	C. An alert if the daily cleanup job fails or skips
	D. SLO on notification delivery latency (e.g., 99th percentile < 500ms from publish to SSE delivery)
	E. All of B, C, and D

	**Answer:** A
