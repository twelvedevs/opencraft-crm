# Notification Service — Updated Design Spec

**Date:** 2026-03-30
**Status:** Approved
**Scope:** Platform-layer Notification Service — real-time in-app notifications via SSE, Redis pub/sub fan-out, per-user read state, 7-day persistence
**Supersedes:** `docs/superpowers/specs/2026-03-25-notification-service-design.md`

---

## Changelog from 2026-03-25 spec

| Section | Change |
|---|---|
| §2 Architecture | SSE auth via `@microsoft/fetch-event-source` polyfill noted; service-to-service JWT clarified (shared HMAC secret) |
| §3 Channel Model | Strict allowlist enforcement added — unknown prefix patterns rejected with `400` |
| §4.2 SSE Stream | Replay cap (200 notifications) + `replay-truncated` event; per-user connection soft limit with `connection-limit` warning event; `X-Connection-ID` header protocol documented |
| §4.3 Notification History | `X-Total-Count` response header added for unread badge count |
| §4.1 Publish | Rate limiting (per-channel, 100/min); payload size clarified as UTF-8 byte length; Redis failure handling updated |
| §5 Fan-out Flow | Redis unavailability: DB write succeeds + BullMQ job retries Redis PUBLISH |
| §7 TTL Cleanup | Fixed UTC cron at 2:00 AM UTC |
| §8 Service Layout | `cleanup-worker.ts` and `publish-retry.ts` queue workers noted |
| §10 Key Decisions | New entries for all of the above |

---

## 1. Overview

The Notification Service (`apps/platform/notification`) is a **platform-layer real-time delivery rail** for in-app notifications. It is fully domain-agnostic — it has no concept of leads, coordinators, or pipeline stages.

**Core responsibilities:**
- Accept notification publishes from product-layer services via REST
- Persist notifications with a 7-day TTL
- Fan-out notifications to subscribed browser clients via Server-Sent Events (SSE)
- Track per-user read state (read/unread, cross-tab sync)
- Replay missed notifications to reconnecting clients

**Out of scope:**
- Push notifications (future)
- Email or SMS notifications (Email Service, Messaging Service)
- Notification routing logic — product services decide which channel to publish to
- `@platform/notification-ui` React package (planned for a future phase)

---

## 2. Architecture

```
Product Layer (Conversation Service, etc.)
        │
        ▼  POST /notifications/publish  { channel, title, body, payload }
        │  service-to-service JWT (shared HMAC secret, internal VPC)
┌──────────────────────────────────────────────────────┐
│              Notification Service                     │
│   apps/platform/notification                         │
│                                                      │
│  REST API (Fastify)                                  │
│    ├── POST /notifications/publish                   │
│    │   → validate → write to DB → BullMQ fallback    │
│    │   → Redis PUBLISH (with BullMQ retry on failure) │
│    ├── GET  /notifications/stream  (SSE)             │
│    │   → user JWT (via fetch-event-source polyfill)  │
│    │   → subscribe channels → stream                 │
│    ├── GET  /notifications          (history)        │
│    ├── POST /notifications/:id/read                  │
│    └── POST /notifications/read-all                  │
│                                                      │
│  SSE Manager                                         │
│    → Redis PSUBSCRIBE "notif:*"                      │
│    → in-memory: channel → Set<SseConnection>         │
│    → in-memory: user_id → Set<SseConnection>         │
│                                                      │
│  BullMQ Queues                                       │
│    → publish-retry: Redis PUBLISH retry on failure   │
│    → cleanup: daily TTL deletion at 2:00 AM UTC      │
│                                                      │
│  PostgreSQL (platform_notifications)                 │
│  Redis Pub/Sub + BullMQ                              │
└──────────────────────────────────────────────────────┘
        │
        ▼  SSE stream  (Authorization header via fetch-event-source)
   Browser clients (CRM Web App)
```

**SSE over WebSocket:** Notifications are strictly server-to-client. SSE is a simpler protocol than WebSocket — no upgrade handshake, works through standard HTTP load balancers, auto-reconnects natively. No bidirectional communication is needed.

**SSE client library:** The browser's native `EventSource` API cannot set custom headers. The CRM Web App uses `@microsoft/fetch-event-source` (or equivalent fetch-based polyfill) for the SSE connection, which supports the `Authorization: Bearer <token>` header. This is a client-side requirement; the service itself is standard SSE.

**Redis pub/sub for cross-instance fan-out:** Each ECS Fargate instance holds its own in-memory map of `channel → Set<SseConnection>`. When any instance receives a `POST /notifications/publish`, it writes to the DB then publishes to Redis. All instances receive the Redis message and fan-out to their locally held connections subscribed to that channel. Scales horizontally without sticky sessions.

**Redis unavailability:** If Redis is unavailable at publish time, the DB write still commits and a BullMQ `publish-retry` job is queued for eventual fan-out. DB is the source of truth; Redis is the delivery mechanism. Clients that miss the live push will receive the notification on reconnect via `Last-Event-ID` replay.

**Service-to-service JWT:** The `POST /notifications/publish` endpoint validates a JWT signed with a shared HMAC secret stored in AWS Secrets Manager. All platform services share this secret. The JWT `sub` claim identifies the calling service (used for per-service identification in logs and rate limit headers).

**No EventBridge:** This service neither publishes nor subscribes to EventBridge. Product services call `POST /notifications/publish` directly.

---

## 3. Channel Model

A channel is an arbitrary string. The Notification Service enforces a **strict allowlist of channel prefixes** — requests with unrecognized prefixes are rejected with `400`.

**Allowed channel patterns:**

| Pattern | Example | Use case |
|---|---|---|
| `location:{location_id}:{type}` | `location:abc123:inbound_sms` | Location-scoped notifications |
| `location:{location_id}:escalation` | `location:abc123:escalation` | Escalated conversations |
| `user:{user_id}:{type}` | `user:xyz789:task` | User-specific task reminders |
| `global:system` | `global:system` | System-wide alerts |

Any channel string that does not match one of these patterns returns `400 { "error": "invalid_channel_pattern" }` on both `POST /notifications/publish` and `GET /notifications/stream`.

**Access control by prefix:**

| Prefix | Rule |
|---|---|
| `location:{location_id}:*` | `location_id` must be present in the JWT's location claims |
| `user:{user_id}:*` | `user_id` must match the JWT subject |
| `global:*` | Open to any authenticated user |

**Redis namespace:** To avoid collisions with BullMQ keys, internal Redis pub/sub channels are prefixed:
- `notif:channel:{channel}` — notification fan-out
- `notif:user:{user_id}:reads` — cross-tab read-state sync

---

## 4. API

### 4.1 Publish a Notification

```
POST /notifications/publish
```

Called by product-layer services. Requires service-to-service JWT (internal VPC — not exposed publicly).

**Rate limit:** 100 publishes per minute per channel. Exceeding this returns `429` with `Retry-After` header. The per-channel limit protects against a single noisy channel (e.g., a runaway automation) flooding storage and Redis. Limit is tracked in Redis with a 60-second sliding window.

Request body:
```json
{
  "channel": "location:uuid:inbound_sms",
  "title": "New message from Sara Johnson",
  "body": "Hey, is the appointment still on?",
  "payload": { "conversation_id": "uuid", "lead_id": "uuid" }
}
```

- `channel` — required. Must match an allowed channel pattern (see §3). `400` if pattern is unrecognized.
- `title` — required. Short notification title.
- `body` — optional. Longer description text.
- `payload` — optional. Arbitrary JSON passed through to the browser client (e.g. IDs for deep-linking). Max 4KB, measured as the UTF-8 byte length of the serialized JSON string.

Responses:
- `201` — `{ "notification_id": "uuid" }` — accepted and persisted.
- `400` — missing required fields (`channel`, `title`); unrecognized channel pattern; or `payload` exceeds 4KB (UTF-8 bytes).
- `401` / `403` — missing or invalid service-to-service JWT.
- `429` — per-channel rate limit exceeded. `Retry-After: <seconds>` header included.

**On Redis failure:** The DB write commits and returns `201`. A BullMQ `publish-retry` job is queued with the notification payload. The worker retries the Redis PUBLISH with exponential backoff (3 attempts, 1s/5s/30s delays). If all retries fail, the notification remains in the DB and will be delivered on the next client reconnect via `Last-Event-ID` replay.

### 4.2 SSE Stream

```
GET /notifications/stream?channels=location:X:inbound_sms,location:X:escalation
```

User JWT in `Authorization: Bearer <token>` header, sent via `@microsoft/fetch-event-source` polyfill (native `EventSource` cannot set headers). Establishes an SSE connection.

- `channels` — comma-separated list of channels to subscribe to. All must match allowed patterns; `400` if any do not. All must pass access control; `403` if any fail.

**On connect:**
1. Validate JWT → extract `user_id`
2. Validate all `channels` against allowed patterns → `400` if any are unrecognized
3. Validate channel access (per §3 rules) → `403` if any channel fails
4. Check per-user connection limit:
   - Soft limit: **10 concurrent SSE connections per `user_id`**
   - When the 11th connection arrives, send a `connection-limit` event to the **oldest** connection for that user, then close it, before accepting the new connection
5. Check `Last-Event-ID` header — if present, it is a `seq` bigint. Query DB for notifications with `seq > $last_event_id` in the requested channels, capped at **200 rows**, and replay before resuming live stream. If the result is truncated at 200, send a `replay-truncated` event first.
6. Register connection in the SSE Manager's in-memory maps (channel map and user map)
7. On disconnect, remove from both maps

**Event types streamed:**

New notification:
```
id: <seq>
event: notification
data: {"notification_id":"uuid","seq":42,"channel":"location:X:inbound_sms","title":"...","body":"...","payload":{...},"created_at":"..."}
```

Replay truncated (sent before replayed events when > 200 missed):
```
event: replay-truncated
data: {"first_seq":<oldest replayed seq>,"replayed":200}
```

Connection limit warning (sent to oldest connection before it is closed):
```
event: connection-limit
data: {"message":"Maximum concurrent connections reached. This connection will be closed."}
```

Single read sync (when this user marks one notification read in another tab):
```
event: read
data: {"notification_id":"uuid"}
```

Bulk read sync (when this user marks all notifications read in another tab):
```
event: read-all
data: {"notification_ids":["uuid","uuid"]}
```

Keepalive (every 30s to prevent proxy timeouts):
```
: keepalive
```

**`id` field:** The SSE event ID is the `seq` value (bigint), not the UUID. This enables correct `Last-Event-ID` replay — `WHERE seq > $last_event_id` is unambiguous. Read-sync and control events do not carry an `id` field (they are not replayable).

**`X-Connection-ID` header:** When a client establishes an SSE connection, it generates a random UUID and sends it as `X-Connection-ID`. The server stores this ID on the `SseConnection` object. When the client calls `POST /notifications/:id/read` or `POST /notifications/read-all`, it sends the same `X-Connection-ID` header. The server includes this connection ID in the Redis pub/sub message so the SSE Manager can exclude the originating connection from the read-sync broadcast.

### 4.3 Notification History

```
GET /notifications?channels=location:X:inbound_sms,location:X:escalation&unread=true&limit=50&before=<cursor>
```

Returns paginated notification history for the specified channels. Applies the same channel access control as `GET /notifications/stream`.

**Unread badge count:** The response includes an `X-Total-Count` header containing the total unread notification count across the requested channels for the authenticated user (ignoring `limit`/`before` pagination). The frontend uses this for the notification bell badge — it calls `GET /notifications?unread=true&limit=1` and reads `X-Total-Count` rather than a separate endpoint.

Response:
```json
{
  "notifications": [
    {
      "notification_id": "uuid",
      "channel": "location:X:inbound_sms",
      "title": "New message from Sara Johnson",
      "body": "...",
      "payload": { "conversation_id": "uuid" },
      "read": false,
      "created_at": "2026-03-25T10:00:00Z"
    }
  ],
  "next_cursor": "..."
}
```

Response headers:
- `X-Total-Count: <n>` — total unread count across requested channels for authenticated user (present on all responses, `0` when `unread=false` filter not applied or when all are read)

Cursor-based pagination using `(created_at DESC, id DESC)` for deterministic tie-breaking.

### 4.4 Mark Read

```
POST /notifications/:id/read
Headers: X-Connection-ID: <uuid>
```

Inserts a `notification_reads` row for the authenticated user. Publishes `{ notification_id, originating_connection_id }` to `notif:user:{user_id}:reads` in Redis — all other open SSE connections for this user receive an `event: read` push. The originating connection (identified by `X-Connection-ID`) is excluded from the broadcast.

Idempotent — calling twice has no error (unique constraint on `(user_id, notification_id)`, upsert).

Responses:
- `200 {}` — read recorded.
- `404` — notification does not exist or has expired.

```
POST /notifications/read-all
Headers: X-Connection-ID: <uuid>
Body: { "channels": ["location:X:inbound_sms", "location:X:escalation"] }
```

Bulk-inserts `notification_reads` rows for all unread notifications in the specified channels for the authenticated user. Publishes a **single** Redis message `{ notification_ids: [...], originating_connection_id }` to `notif:user:{user_id}:reads` (not one per notification). All other open SSE connections for this user receive a single `event: read-all` push with the full list of IDs.

Responses:
- `200 { "marked": <count> }` — count of newly marked-read notifications (0 if all were already read).
- `403` — any channel in the request body is not authorized for this user.

---

## 5. Fan-out Flow

```
POST /notifications/publish received by any ECS instance
  → validate request (channel pattern, required fields, payload size, JWT, rate limit)
  → INSERT into notifications (id, seq, channel, title, body, payload, expires_at = now()+7d)
  → attempt Redis PUBLISH "notif:channel:{channel}" { notification_id, seq, channel, title, body, payload, created_at }
      ├── success → return 201 { notification_id }
      └── failure → enqueue BullMQ publish-retry job { notification_id, channel, payload }
                 → return 201 { notification_id }  (DB write succeeded, eventual fan-out)

All ECS instances (including publisher):
  → SSE Manager receives Redis message via PSUBSCRIBE "notif:*"
  → inspect Redis channel name:
      matches "notif:channel:*" → look up channel in in-memory map
                                  → write "event: notification" SSE to each matching connection
      matches "notif:user:*:reads" → find all SseConnections for user_id (extracted from channel name)
                                     → exclude connection with matching originating_connection_id
                                     → write "event: read" or "event: read-all" SSE to remaining connections
  → connections not matching: no-op

BullMQ publish-retry worker (on Redis recovery):
  → dequeue job { notification_id, channel, payload }
  → Redis PUBLISH "notif:channel:{channel}" { ...payload }
  → on success: delete job
  → on failure: retry with backoff (1s, 5s, 30s), discard after 3 attempts
```

**Read sync flow:**
```
POST /notifications/:id/read
  → INSERT notification_reads (user_id, notification_id)   -- upsert on conflict
  → Redis PUBLISH "notif:user:{user_id}:reads" { notification_id, originating_connection_id }
  → return 200 {}

POST /notifications/read-all
  → bulk INSERT notification_reads for all unread in channels
  → Redis PUBLISH "notif:user:{user_id}:reads" { notification_ids: [...], originating_connection_id }
  → return 200 { marked: <count> }
```

---

## 6. Database Schema — `platform_notifications`

```sql
-- One row per published notification
notifications (
  id          uuid PRIMARY KEY,
  seq         bigint NOT NULL UNIQUE DEFAULT nextval('notifications_seq'),  -- monotonic SSE event ID for Last-Event-ID replay
  channel     text NOT NULL,
  title       text NOT NULL,
  body        text,
  payload     jsonb,
  expires_at  timestamptz NOT NULL,   -- created_at + 7 days
  created_at  timestamptz NOT NULL DEFAULT now()
)

-- Per-user read receipts — only inserted on explicit read action
notification_reads (
  user_id         uuid NOT NULL,
  notification_id uuid REFERENCES notifications ON DELETE CASCADE NOT NULL,
  read_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, notification_id)
)
```

**Indexes:**
- `notifications(channel, created_at DESC, id DESC)` — history query per channel with deterministic cursor tie-breaking
- `notifications(channel, seq)` — `Last-Event-ID` replay query (`WHERE channel IN (...) AND seq > $last`)
- `notifications(expires_at)` — TTL cleanup job scan
- `notification_reads(notification_id)` — supports cascade delete performance
- `notification_reads(user_id, notification_id) WHERE read_at IS NOT NULL` — unread count query (`X-Total-Count`)

**Design notes:**
- Notifications are stored once per publish, not per recipient user. Read state tracked separately in `notification_reads`.
- `GET /notifications` LEFT JOINs `notification_reads` on `(user_id = $currentUser AND notification_id = notifications.id)` to compute `read: true|false` per row.
- `ON DELETE CASCADE` on `notification_reads` — when cleanup deletes expired notifications, read records follow automatically with no orphan cleanup needed.

---

## 7. TTL Cleanup

A BullMQ repeatable job runs daily at **2:00 AM UTC** (cron: `0 2 * * *`):

```sql
DELETE FROM notifications WHERE expires_at < now();
```

Cascades to `notification_reads` via `ON DELETE CASCADE`. BullMQ ensures only one instance runs the job at a time across all ECS instances (deduplication via job key). Redis already in stack for pub/sub, so BullMQ adds no new infrastructure.

---

## 8. Service Layout

```
apps/platform/notification/
├── src/
│   ├── routes/
│   │   ├── publish.ts              # POST /notifications/publish
│   │   ├── stream.ts               # GET /notifications/stream (SSE)
│   │   └── notifications.ts        # GET /notifications, POST /:id/read, POST /read-all
│   ├── services/
│   │   ├── publisher.ts            # DB write + Redis PUBLISH + BullMQ fallback
│   │   ├── sse-manager.ts          # in-memory connection maps + Redis PSUBSCRIBE handler
│   │   ├── channel-validator.ts    # allowed channel pattern enforcement
│   │   └── rate-limiter.ts         # per-channel sliding-window rate limit (Redis)
│   ├── queue/
│   │   ├── publish-retry.worker.ts # BullMQ worker: retry Redis PUBLISH after failure
│   │   └── cleanup.worker.ts       # BullMQ repeatable job: delete expired notifications at 2am UTC
│   ├── repositories/
│   │   └── notifications.repo.ts
│   └── index.ts
├── migrations/
├── test/
│   ├── unit/
│   └── integration/
├── Dockerfile
├── package.json
└── tsconfig.json
```

**Runtime dependencies:**
- PostgreSQL (`platform_notifications` schema)
- Redis (pub/sub fan-out + BullMQ queues)
- AWS Secrets Manager (shared HMAC secret for service-to-service JWT)

---

## 9. Testing Strategy

### Unit Tests (Vitest)

Pure logic with no external dependencies:

- **SSE Manager:**
  - Register connection → assert in channel map and user map
  - Deregister on disconnect → assert removed from both maps
  - Redis message for matching channel → assert SSE write called
  - Redis message for non-matching channel → assert no write
  - Read-sync Redis message → assert `event: read` written to correct user's connections only
  - Read-sync not echoed back to originating connection (matched by `originating_connection_id`)
  - Per-user connection limit: 11th connection triggers `connection-limit` event on oldest, oldest is closed
- **Publisher:**
  - DB insert called with correct fields including `expires_at = now()+7d`
  - Redis PUBLISH called with correct namespaced key
  - On Redis failure: BullMQ job enqueued with correct payload
  - `notification_id` returned in both success and Redis-failure paths
- **Channel validator:**
  - Valid patterns accepted: `location:uuid:inbound_sms`, `user:uuid:task`, `global:system`
  - Invalid patterns rejected: `unknown:xyz`, `location:` (missing segments), arbitrary strings
- **Rate limiter:**
  - First 100 publishes within 60s window for a channel: allowed
  - 101st publish: returns rate-limit exceeded
  - After window expires: counter resets

### Integration Tests (Vitest + real Postgres + real Redis)

- Publish → SSE client subscribed to matching channel receives `event: notification` with correct payload
- Publish to channel X → SSE client subscribed to channel Y receives nothing
- Mark read → `notification_reads` row inserted; second SSE connection for same user receives `event: read`; `X-Connection-ID` on originating connection suppresses echo; calling mark-read twice is idempotent
- Mark read on expired/non-existent notification → `404`
- `POST /read-all` → all unread notifications for specified channels marked read; single `event: read-all` pushed to other connections with full `notification_ids` array; response includes correct `marked` count
- Subscribe to unauthorized channel (wrong `location_id` in JWT) → `403`, connection closed
- Subscribe with unknown channel pattern → `400`, connection closed
- `GET /notifications` — returns history with correct `read: true/false` per item; `unread=true` filter works; `X-Total-Count` header matches actual unread count; pagination cursor advances correctly
- Reconnect with `Last-Event-ID` → missed notifications replayed; no duplicate delivery
- Reconnect with `Last-Event-ID` pointing to > 200 missed notifications → replay capped at 200; `replay-truncated` event sent first with correct `replayed` and `first_seq`
- Expired notification not returned in `GET /notifications` history
- Cleanup worker — deletes rows where `expires_at < now()`; `notification_reads` rows cascade-deleted
- Per-channel rate limit — 101st publish within 60s returns `429`
- Redis unavailable during publish → DB write succeeds, `201` returned, BullMQ retry job created → after Redis recovers, worker delivers to subscribed clients

### Contract Tests

- `POST /notifications/publish` — verify callers send the expected payload shape (channel, title, body, payload)
- SSE `event: notification` format — notification_id, seq, channel, title, body, payload, created_at fields match what CRM frontend expects
- SSE `event: read` format — notification_id field present
- SSE `event: read-all` format — notification_ids array present
- SSE `event: replay-truncated` format — first_seq and replayed fields present
- `X-Total-Count` response header present on `GET /notifications`

---

## 10. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Transport | SSE over WebSocket | Notifications are server-to-client only. SSE is simpler — no upgrade handshake, works through standard LBs, browser auto-reconnects. No bidirectional communication needed. |
| SSE client | `@microsoft/fetch-event-source` (browser) | Native `EventSource` cannot set `Authorization` header. Fetch-based polyfill supports custom headers while keeping the server-side implementation as standard SSE. |
| Cross-instance fan-out | Redis pub/sub (PSUBSCRIBE `notif:*`) | Each instance holds its own in-memory SSE connections. Redis broadcasts publishes to all instances. No sticky sessions — ECS can autoscale freely. |
| Delivery model | Product services POST directly (`POST /notifications/publish`) | Service stays domain-agnostic. Product-layer callers own routing logic. No EventBridge subscription needed. |
| Channel allowlist | Strict — reject unknown prefixes with `400` | Fail-closed prevents uncontrolled channel proliferation and makes access control rules exhaustive. |
| Channel access control | JWT claim validation on subscribe | For `location:{id}:*`, validate `location_id` in JWT claims. For `user:{id}:*`, validate `user_id` matches JWT subject. No Identity Service call needed — claims embedded in JWT. |
| Service-to-service JWT | Shared HMAC secret in AWS Secrets Manager | Simple, low-overhead auth for trusted internal VPC calls. Per-service keys add key rotation complexity without meaningful security benefit on an internal VPC. |
| Publish rate limit | Per-channel, 100/min, sliding window in Redis | Protects against runaway automation flooding a single channel. Per-channel (not per-service) because the damage vector is channel-specific (DB rows, Redis messages, SSE fan-out). |
| Redis unavailability | DB write commits; BullMQ retries Redis PUBLISH | DB is the source of truth. Notifications are never lost. Clients that miss the live push receive them via `Last-Event-ID` replay on next reconnect. |
| Notification storage | One row per publish, read state in separate table | Avoids fan-out-on-write to unknown recipients. `GET /notifications` LEFT JOINs reads per user at query time. Simpler writes, acceptable read cost at expected volumes. |
| Missed notification replay | `Last-Event-ID` (seq bigint) + DB query, capped at 200 | Monotonic `seq` makes `WHERE seq > $last` unambiguous. Cap prevents large reconnect storms from overwhelming the instance. `replay-truncated` event tells the client it missed more than 200. |
| Per-user connection limit | Soft limit of 10; warn-and-close oldest | Prevents excessive memory use from tabs left open. Soft (warn before close) rather than hard (immediate reject) gives the oldest tab a clean shutdown signal. |
| Originating connection exclusion | `X-Connection-ID` client header + server-side storage passed in Redis message | Client sets the ID on SSE connect; sends same ID on read requests. Server passes it in Redis pub/sub payload so all instances can exclude the originating connection. Clean separation: client owns the ID, server passes it through. |
| Unread badge count | `X-Total-Count` header on `GET /notifications` | Avoids a dedicated `/unread-count` endpoint. Frontend calls `GET /notifications?unread=true&limit=1` and reads the header. Piggybacks on existing access control and channel validation. |
| TTL | 7 days, `expires_at` column + BullMQ cron at 2:00 AM UTC | Bounds storage. Fixed UTC time is predictable and avoids timing drift on service restarts. BullMQ deduplicates across instances. |
| Cross-tab read sync | Redis publish to `notif:user:{user_id}:reads` | When a user reads in one tab, all other open connections get `event: read`. Badge updates without polling. |
| Observability | Existing Datadog APM only | No additional SLOs, SSE fan-out lag alerts, or cleanup failure alerts required at this stage. |
