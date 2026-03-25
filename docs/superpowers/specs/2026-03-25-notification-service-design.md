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
- Channel access control — any authenticated user may subscribe to any channel; the CRM frontend subscribes only to authorized channels

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
- `payload` — optional. Arbitrary JSON passed through to the browser client (e.g. IDs for deep-linking).

Response: `201 { "notification_id": "uuid" }`

### 4.2 SSE Stream

```
GET /notifications/stream?channels=location:X:inbound_sms,location:X:escalation
```

User JWT in `Authorization: Bearer <token>` header. Establishes an SSE connection.

- `channels` — comma-separated list of channels to subscribe to for this connection.

**On connect:**
1. Validate JWT → extract `user_id`
2. Check `Last-Event-ID` header — if present, replay notifications from DB newer than that ID for the requested channels before resuming live stream
3. Register connection in the SSE Manager's in-memory map for each channel
4. On disconnect, remove from map

**Event types streamed:**

New notification:
```
id: <notification_id>
event: notification
data: {"notification_id":"uuid","channel":"location:X:inbound_sms","title":"...","body":"...","payload":{...},"created_at":"..."}
```

Cross-tab read sync (when this user marks a notification read in another tab):
```
id: read:<notification_id>
event: read
data: {"notification_id":"uuid"}
```

Keepalive (every 30s to prevent proxy timeouts):
```
: keepalive
```

### 4.3 Notification History

```
GET /notifications?channels=loc:X:inbound_sms,loc:X:escalation&unread=true&limit=50&before=<cursor>
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

```
POST /notifications/read-all
Body: { "channels": ["location:X:inbound_sms", "location:X:escalation"] }
```

Bulk-inserts `notification_reads` rows for all unread notifications in the specified channels for the authenticated user. Same Redis read-sync publish.

---

## 5. Fan-out Flow

```
POST /notifications/publish received by any ECS instance
  → validate request
  → INSERT into notifications (id, channel, title, body, payload, expires_at = now()+7d)
  → Redis PUBLISH "notif:channel:{channel}" { notification_id, channel, title, body, payload, created_at }
  → return 201 { notification_id }

All ECS instances (including publisher):
  → receive Redis message on "notif:channel:{channel}"
  → look up channel in SSE Manager's in-memory map
  → for each matching SseConnection: write SSE event
  → connections not subscribed to that channel: no-op
```

**Read sync flow:**
```
POST /notifications/:id/read
  → INSERT notification_reads (user_id, notification_id)
  → Redis PUBLISH "notif:user:{user_id}:reads" { notification_id }

All ECS instances:
  → receive Redis message on "notif:user:{user_id}:reads"
  → find all SseConnections for user_id
  → write "event: read" SSE event to each (excluding the connection that triggered it)
```

---

## 6. Database Schema — `platform_notifications`

```sql
-- One row per published notification
notifications (
  id          uuid PRIMARY KEY,
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
- Mark read → `notification_reads` row inserted; second SSE connection for same user receives `event: read`; calling mark-read twice is idempotent (no error)
- `POST /read-all` → all unread notifications for specified channels marked read; read-sync published for each
- `GET /notifications` — returns history with correct `read: true/false` per item; `unread=true` filter works; pagination cursor advances correctly
- Reconnect with `Last-Event-ID` → missed notifications replayed from DB before live stream resumes; no duplicate delivery of already-seen notifications
- Expired notification not returned in `GET /notifications` history
- Cleanup worker — deletes rows where `expires_at < now()`; `notification_reads` rows cascade-deleted

### Contract Tests

- `POST /notifications/publish` — verify callers send the expected payload shape (channel, title, body, payload)
- SSE `event: notification` format — channel, notification_id, title, body, payload, created_at fields match what CRM frontend expects
- SSE `event: read` format — notification_id field present

---

## 10. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Transport | SSE over WebSocket | Notifications are server-to-client only. SSE is simpler — no upgrade handshake, works through standard LBs, browser auto-reconnects. No bidirectional communication needed. |
| Cross-instance fan-out | Redis pub/sub (PSUBSCRIBE `notif:*`) | Each instance holds its own in-memory SSE connections. Redis broadcasts publishes to all instances. No sticky sessions — ECS can autoscale freely. |
| Delivery model | Product services POST directly (`POST /notifications/publish`) | Service stays domain-agnostic. Product-layer callers own routing logic (which event → which channel). No EventBridge subscription or rule DSL needed. |
| Channel access control | None — any authenticated user may subscribe | Access control lives in the CRM frontend (only subscribes to authorized channels). Adding Identity Service validation per subscription would add latency and coupling with no meaningful security gain in an internal VPC. |
| Notification storage | One row per publish, read state in separate table | Avoids fan-out-on-write to unknown recipients. `GET /notifications` LEFT JOINs reads per user at query time. Simpler writes, acceptable read cost at expected notification volumes. |
| Missed notification replay | `Last-Event-ID` header + DB query on reconnect | Browser `EventSource` sends `Last-Event-ID` automatically on reconnect. Service queries DB for notifications newer than that ID and replays before resuming live stream. No separate replay queue needed. |
| TTL | 7 days, enforced via `expires_at` + daily BullMQ cleanup | Bounds storage. Redis already in stack for pub/sub, so BullMQ adds no new infrastructure. |
| Cross-tab read sync | Redis publish to `notif:user:{user_id}:reads` | When a user reads a notification in one tab, the SSE manager pushes `event: read` to all their other open connections. Badge updates without polling. |
