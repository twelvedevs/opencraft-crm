# Notification Service — Design Spec

**Date:** 2026-03-25
**Status:** Draft
**Scope:** Platform-layer Notification Service — real-time in-app notifications via SSE, Redis pub/sub fan-out, per-user read state, 7-day persistence

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

---

## 2. Architecture

```
Product Layer (Conversation Service, etc.)
        │
        ▼  POST /notifications/publish  { channel, title, body, payload }
        │  service-to-service JWT (internal VPC)
┌──────────────────────────────────────────────────────┐
│              Notification Service                     │
│   apps/platform/notification                         │
│                                                      │
│  REST API (Fastify)                                  │
│    ├── POST /notifications/publish                   │
│    │   → write to DB → Redis PUBLISH                 │
│    ├── GET  /notifications/stream  (SSE)             │
│    │   → user JWT → subscribe channels → stream      │
│    ├── GET  /notifications          (history)        │
│    ├── POST /notifications/:id/read                  │
│    └── POST /notifications/read-all                  │
│                                                      │
│  SSE Manager                                         │
│    → Redis PSUBSCRIBE "notif:*"                      │
│    → in-memory: channel → Set<SseConnection>         │
│                                                      │
│  PostgreSQL (platform_notifications)                 │
│  Redis Pub/Sub + BullMQ (cleanup)                    │
└──────────────────────────────────────────────────────┘
        │
        ▼  SSE stream  (user JWT in Authorization header)
   Browser clients (CRM Web App)
```

**SSE over WebSocket:** Notifications are strictly server-to-client. SSE is a simpler protocol than WebSocket — no upgrade handshake, works through standard HTTP load balancers, auto-reconnects natively. No bidirectional communication is needed.

**Redis pub/sub for cross-instance fan-out:** Each ECS Fargate instance holds its own in-memory map of `channel → Set<SseConnection>`. When any instance receives a `POST /notifications/publish`, it writes to the DB then publishes to Redis. All instances receive the Redis message and fan-out to their locally held connections subscribed to that channel. Scales horizontally without sticky sessions.

**No EventBridge:** This service neither publishes nor subscribes to EventBridge. Product services call `POST /notifications/publish` directly.

---

## 3. Channel Model

A channel is an arbitrary string. The Notification Service has no knowledge of what channels mean — product services define the naming convention.

**Recommended convention (enforced by callers, not this service):**

| Pattern | Example | Use case |
|---|---|---|
| `location:{location_id}:{type}` | `location:abc123:inbound_sms` | Location-scoped notifications |
| `location:{location_id}:escalation` | `location:abc123:escalation` | Escalated conversations |
| `user:{user_id}:{type}` | `user:xyz789:task` | User-specific task reminders |
| `global:system` | `global:system` | System-wide alerts |

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

Request body:
```json
{
  "channel": "location:uuid:inbound_sms",
  "title": "New message from Sara Johnson",
  "body": "Hey, is the appointment still on?",
  "payload": { "conversation_id": "uuid", "lead_id": "uuid" }
}
```

- `channel` — required. Target channel string.
- `title` — required. Short notification title.
- `body` — optional. Longer description text.
- `payload` — optional. Arbitrary JSON passed through to the browser client (e.g. IDs for deep-linking). Max 4KB.

Responses:
- `201` — `{ "notification_id": "uuid" }` — accepted and persisted.
- `400` — missing required fields (`channel`, `title`), or `payload` exceeds 4KB.
- `401` / `403` — missing or invalid service-to-service JWT.

### 4.2 SSE Stream

```
GET /notifications/stream?channels=location:X:inbound_sms,location:X:escalation
```

User JWT in `Authorization: Bearer <token>` header. Establishes an SSE connection.

- `channels` — comma-separated list of channels to subscribe to for this connection.

**On connect:**
1. Validate JWT → extract `user_id`
2. Validate channel access — for each channel in `channels`:
   - `location:{location_id}:*` — verify `location_id` is present in the JWT's location claims. Return `403` and close the connection if any channel fails.
   - `user:{user_id}:*` — verify `user_id` matches the JWT subject. Return `403` if mismatched.
   - `global:*` — open to any authenticated user.
3. Check `Last-Event-ID` header — if present, `Last-Event-ID` is a `seq` value (bigint). Query DB for notifications with `seq > $last_event_id` in the requested channels and replay before resuming live stream.
4. Register connection in the SSE Manager's in-memory map for each channel
5. On disconnect, remove from map

**Event types streamed:**

New notification:
```
id: <seq>
event: notification
data: {"notification_id":"uuid","seq":42,"channel":"location:X:inbound_sms","title":"...","body":"...","payload":{...},"created_at":"..."}
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

**`id` field:** The SSE event ID is the `seq` value (bigint), not the UUID. This enables correct `Last-Event-ID` replay — `WHERE seq > $last_event_id` is unambiguous. Read-sync events do not carry an `id` field (they are not replayable).

### 4.3 Notification History

```
GET /notifications?channels=location:X:inbound_sms,location:X:escalation&unread=true&limit=50&before=<cursor>
```

Returns paginated notification history for the specified channels. `read` field per item reflects read state for the authenticated user (LEFT JOIN on `notification_reads`). Cursor-based pagination using `created_at` + `id`.

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

### 4.4 Mark Read

```
POST /notifications/:id/read
```

Inserts a `notification_reads` row for the authenticated user. Publishes `{ notification_id }` to `notif:user:{user_id}:reads` in Redis — all other open SSE connections for this user receive an `event: read` push, updating their badge immediately.

Idempotent — calling twice has no error (unique constraint on `(user_id, notification_id)`, upsert).

Responses:
- `200 {}` — read recorded.
- `404` — notification does not exist or has expired (the `notifications` FK would reject the insert — return `404` to the client rather than a `500`).

```
POST /notifications/read-all
Body: { "channels": ["location:X:inbound_sms", "location:X:escalation"] }
```

Bulk-inserts `notification_reads` rows for all unread notifications in the specified channels for the authenticated user. Publishes a **single** Redis message `{ notification_ids: ["uuid", ...] }` to `notif:user:{user_id}:reads` (not one per notification). All other open SSE connections for this user receive a single `event: read-all` push with the full list of IDs.

Responses:
- `200 { "marked": <count> }` — count of newly marked-read notifications (0 if all were already read).

---

## 5. Fan-out Flow

```
POST /notifications/publish received by any ECS instance
  → validate request
  → INSERT into notifications (id, seq, channel, title, body, payload, expires_at = now()+7d)
  → Redis PUBLISH "notif:channel:{channel}" { notification_id, seq, channel, title, body, payload, created_at }
  → return 201 { notification_id }

All ECS instances (including publisher):
  → SSE Manager receives Redis message via PSUBSCRIBE "notif:*"
  → inspect Redis channel name:
      matches "notif:channel:*" → look up channel in in-memory map
                                  → write "event: notification" SSE to each matching connection
      matches "notif:user:*:reads" → find all SseConnections for user_id (extracted from channel name)
                                     → write "event: read" or "event: read-all" SSE to each
                                       (excluding the originating connection via connection ID)
  → connections not matching: no-op
```

**Read sync flow:**
```
POST /notifications/:id/read
  → INSERT notification_reads (user_id, notification_id)   -- upsert on conflict
  → Redis PUBLISH "notif:user:{user_id}:reads" { notification_id }
  → return 200 {}

POST /notifications/read-all
  → bulk INSERT notification_reads for all unread in channels
  → Redis PUBLISH "notif:user:{user_id}:reads" { notification_ids: [...] }   -- single message
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
- `notifications(channel, created_at DESC)` — history query per channel
- `notifications(channel, seq)` — `Last-Event-ID` replay query (`WHERE channel IN (...) AND seq > $last`)
- `notifications(expires_at)` — TTL cleanup job scan
- `notification_reads(notification_id)` — supports cascade delete performance

**Design notes:**
- Notifications are stored once per publish, not per recipient user. Read state tracked separately in `notification_reads`.
- `GET /notifications` LEFT JOINs `notification_reads` on `(user_id = $currentUser AND notification_id = notifications.id)` to compute `read: true|false` per row.
- `ON DELETE CASCADE` on `notification_reads` — when cleanup deletes expired notifications, read records follow automatically with no orphan cleanup needed.

---

## 7. TTL Cleanup

A BullMQ repeatable job runs daily:

```sql
DELETE FROM notifications WHERE expires_at < now();
```

Cascades to `notification_reads` via `ON DELETE CASCADE`. Redis is already a runtime dependency (pub/sub), so BullMQ adds no new infrastructure.

---

## 8. Service Layout

```
apps/platform/notification/
├── src/
│   ├── routes/
│   │   ├── publish.ts           # POST /notifications/publish
│   │   ├── stream.ts            # GET /notifications/stream (SSE)
│   │   └── notifications.ts    # GET /notifications, POST /:id/read, POST /read-all
│   ├── services/
│   │   ├── publisher.ts         # DB write + Redis PUBLISH
│   │   ├── sse-manager.ts       # in-memory connection map + Redis PSUBSCRIBE handler
│   │   └── cleanup-worker.ts    # BullMQ repeatable job — delete expired notifications
│   ├── repositories/
│   │   └── notifications.repo.ts
│   └── index.ts
├── migrations/
├── test/
├── Dockerfile
├── package.json
└── tsconfig.json
```

**Runtime dependencies:**
- PostgreSQL (`platform_notifications` schema)
- Redis (pub/sub fan-out + BullMQ cleanup job)

---

## 9. Testing Strategy

### Unit Tests (Vitest)

Pure logic with no external dependencies:

- **SSE Manager:** register connection → assert in channel map; deregister on disconnect → assert removed; Redis message for matching channel → assert SSE write called; Redis message for non-matching channel → assert no write; read-sync Redis message → assert `event: read` written to correct user's connections only; read-sync not echoed back to originating connection
- **Publisher:** DB insert called with correct fields including `expires_at = now()+7d`; Redis PUBLISH called with correct namespaced key; `notification_id` returned

### Integration Tests (Vitest + real Postgres + real Redis)

- Publish → SSE client subscribed to matching channel receives `event: notification` with correct payload
- Publish to channel X → SSE client subscribed to channel Y receives nothing
- Mark read → `notification_reads` row inserted; second SSE connection for same user receives `event: read`; calling mark-read twice is idempotent (returns `200`, no duplicate DB row)
- Mark read on expired/non-existent notification → `404`
- `POST /read-all` → all unread notifications for specified channels marked read; single `event: read-all` pushed to other connections with full `notification_ids` array; response includes correct `marked` count
- Subscribe to unauthorized channel (wrong `location_id` in JWT) → `403`, connection closed
- `GET /notifications` — returns history with correct `read: true/false` per item; `unread=true` filter works; pagination cursor advances correctly
- Reconnect with `Last-Event-ID` → missed notifications replayed from DB before live stream resumes; no duplicate delivery of already-seen notifications
- Expired notification not returned in `GET /notifications` history
- Cleanup worker — deletes rows where `expires_at < now()`; `notification_reads` rows cascade-deleted

### Contract Tests

- `POST /notifications/publish` — verify callers send the expected payload shape (channel, title, body, payload)
- SSE `event: notification` format — notification_id, seq, channel, title, body, payload, created_at fields match what CRM frontend expects
- SSE `event: read` format — notification_id field present
- SSE `event: read-all` format — notification_ids array present

---

## 10. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Transport | SSE over WebSocket | Notifications are server-to-client only. SSE is simpler — no upgrade handshake, works through standard LBs, browser auto-reconnects. No bidirectional communication needed. |
| Cross-instance fan-out | Redis pub/sub (PSUBSCRIBE `notif:*`) | Each instance holds its own in-memory SSE connections. Redis broadcasts publishes to all instances. No sticky sessions — ECS can autoscale freely. |
| Delivery model | Product services POST directly (`POST /notifications/publish`) | Service stays domain-agnostic. Product-layer callers own routing logic (which event → which channel). No EventBridge subscription or rule DSL needed. |
| Channel access control | JWT claim validation on subscribe | For `location:{id}:*` channels, validate `location_id` is in the JWT's location claims. For `user:{id}:*` channels, validate `user_id` matches JWT subject. `global:*` open to any authenticated user. No Identity Service call needed — claims are embedded in the JWT. |
| Notification storage | One row per publish, read state in separate table | Avoids fan-out-on-write to unknown recipients. `GET /notifications` LEFT JOINs reads per user at query time. Simpler writes, acceptable read cost at expected notification volumes. |
| Missed notification replay | `Last-Event-ID` (seq bigint) + DB query on reconnect | SSE event ID is a monotonic `seq` bigint (Postgres sequence), not a UUID. `WHERE seq > $last_event_id` is unambiguous under concurrent publishes. Browser `EventSource` sends `Last-Event-ID` automatically on reconnect. No separate replay queue needed. |
| TTL | 7 days, enforced via `expires_at` + daily BullMQ cleanup | Bounds storage. Redis already in stack for pub/sub, so BullMQ adds no new infrastructure. |
| Cross-tab read sync | Redis publish to `notif:user:{user_id}:reads` | When a user reads a notification in one tab, the SSE manager pushes `event: read` to all their other open connections. Badge updates without polling. |
