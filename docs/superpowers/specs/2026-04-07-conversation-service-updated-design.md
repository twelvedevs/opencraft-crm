# Conversation Service — Updated Design Spec

**Date:** 2026-04-07
**Status:** Approved
**Scope:** Product-layer Conversation Service — shared SMS inbox, conversation threading, coordinator workflow, AI features, AI Agent autonomous mode
**Supersedes:** `2026-03-25-conversation-service-design.md`
**Changes:** All 31 clarifying questions answered and incorporated as concrete implementation decisions.

---

## 1. Overview

The Conversation Service (`apps/crm/conversation`) bridges the platform-layer Messaging Service and the CRM's Lead records. It owns the shared SMS inbox — message threads, coordinator workflow, and AI assistance.

**Core responsibilities:**
- Receive `inbound_message.received` events → resolve lead by phone → route into a conversation thread
- Store all messages (inbound + outbound) as the source of truth for the inbox thread
- Provide inbox API: list conversations per location, paginated thread view, unread counts per coordinator
- Coordinator workflow: assignment/claiming, internal notes, escalation flags, per-coordinator read tracking
- Outbound send: coordinator sends → call `POST /messages/send` on Messaging Service → store locally
- Track Twilio delivery status per message (from `message.delivered` / `message.failed`)
- Scheduled send: BullMQ delayed jobs owned entirely by this service
- Bulk SMS: BullMQ batch job calling Lead Service + Audience Engine + Messaging Service
- AI features: smart reply drafts, conversation summary, objection handling (on-demand, calling AI Service)
- AI Agent autonomous mode: location-level on/off, BullMQ job per inbound reply, auto-escalation to human
- Publish `message.received` to EventBridge → Automation Engine consumes it; call `POST /notifications/publish` directly → Notification Service

**Out of scope:**
- Template storage and versioning (callers pass body strings inline)
- Email campaigns (Campaign Service)
- Voice/call tracking
- Delivery scheduling for automation sequences (Nurturing Engine)

---

## 2. Architecture

```
                    ┌─────────────────────────────────────────────────┐
                    │            Conversation Service                  │
                    │         apps/crm/conversation                    │
                    │                                                  │
Coordinator ──────► │  REST API (all routes under /conversations)      │
 (via API GW)       │    ├── conversations  (inbox list, thread)       │
                    │    ├── messages       (send, read receipt)       │
                    │    ├── notes          (internal notes)           │
                    │    ├── scheduled      (scheduled sends)          │
                    │    ├── ai             (drafts, summary, objection)│
                    │    ├── bulk-sends     (segment broadcast)        │
                    │    └── settings       (per-location config)      │
                    │                                                  │
EventBridge ──────► │  Event Handlers (via SQS)                        │
  inbound_message   │    ├── inbound-message.handler.ts                │
  message.delivered │    ├── message-delivered.handler.ts              │
  message.failed    │    └── message-failed.handler.ts                 │
                    │                                                  │
                    │  BullMQ Workers                                  │
                    │    ├── ai-agent-reply.worker.ts                  │
                    │    ├── scheduled-send.worker.ts                  │
                    │    └── bulk-send.worker.ts                       │
                    └─────────────────────────────────────────────────┘
                         │           │          │         │
                         ▼           ▼          ▼         ▼
                    Messaging   Lead Service  AI Service  Audience
                    Service     (phone lookup) (drafts)   Engine
                         │
                         ▼  EventBridge
                    message.received → Automation Engine
                         │
                         ▼  POST /notifications/publish
                    Notification Service
```

---

## 3. Package & Runtime

- **npm package name:** `@crm/conversation`
- **Port:** `PORT` env var; defaults to `3006` if unset
- **Runtime:** Node.js 24, TypeScript 5 (ESM — `"type": "module"`), Fastify 5
- **Schema validation:** `@sinclair/typebox` 0.34 — full TypeBox schemas for all request bodies and response shapes

---

## 4. Database

### 4.1 ORM Setup

Configure Knex directly using `knex` + `pg`. Do not use `@ortho/db`.

```ts
const db = knex({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  searchPath: ['crm_conversations'],   // unqualified table names in all queries
});
```

### 4.2 Migration Naming

Timestamp-prefix convention: `20260325000000_create_conversations.ts`

### 4.3 Schema — `crm_conversations`

```sql
-- One row per conversation thread
conversations (
  id                    uuid PRIMARY KEY,
  lead_id               uuid NOT NULL,
  location_id           uuid NOT NULL,
  practice_number       text NOT NULL,           -- E.164 Twilio number (practice side)
  lead_phone            text NOT NULL,           -- E.164 (lead's number on first message)
  status                text NOT NULL DEFAULT 'open',   -- 'open' | 'closed'
  assigned_to           uuid,                    -- user_id; NULL = unassigned
  escalated             boolean NOT NULL DEFAULT false,
  agent_mode_active     boolean NOT NULL DEFAULT false,
  agent_exchange_count  integer NOT NULL DEFAULT 0,
  last_message_at       timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
)

-- Every message in the thread (inbound + outbound + automated)
conversation_messages (
  id                   uuid PRIMARY KEY,
  conversation_id      uuid NOT NULL REFERENCES conversations(id),
  direction            text NOT NULL,            -- 'inbound' | 'outbound'
  author_id            uuid,                     -- user_id for manual outbound; NULL otherwise
  body                 text,
  media_urls           text[],
  message_type         text NOT NULL DEFAULT 'normal',  -- 'normal' | 'stop' | 'unstop'
  status               text NOT NULL,
    -- outbound: 'queued' | 'sent' | 'delivered' | 'failed'
    -- inbound:  'received'
  is_automated         boolean NOT NULL DEFAULT false,  -- sent by Automation/Nurturing Engine
  is_agent             boolean NOT NULL DEFAULT false,  -- sent by AI Agent mode
  messaging_message_id uuid,                     -- Messaging Service message ID
  sent_at              timestamptz,
  delivered_at         timestamptz,
  received_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
)

-- Private staff notes (not visible to leads)
conversation_notes (
  id              uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  author_id       uuid NOT NULL,
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
)

-- Per-coordinator in-app read tracking
conversation_reads (
  conversation_id      uuid NOT NULL,
  user_id              uuid NOT NULL,
  last_read_message_id uuid,                     -- cursor: unread = messages after this one
  read_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
)

-- Coordinator-scheduled future sends
scheduled_messages (
  id              uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  body            text NOT NULL,
  media_url       text,
  scheduled_for   timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'pending',  -- 'pending' | 'sent' | 'cancelled'
  created_by      uuid NOT NULL,
  bullmq_job_id   text,                          -- stored for job.remove() on cancel
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
)

-- Per-location inbox configuration
location_conversation_settings (
  location_id          uuid PRIMARY KEY,
  inactivity_days      integer NOT NULL DEFAULT 30,
  agent_mode_enabled   boolean NOT NULL DEFAULT false,
  agent_max_exchanges  integer NOT NULL DEFAULT 3,
  location_phone       text,                     -- E.164 voice number; used in AI agent disclosure footer
  practice_number      text,                     -- E.164 Twilio number; used as from_number in bulk SMS sends
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (agent_mode_enabled = false OR (location_phone IS NOT NULL AND practice_number IS NOT NULL))
)

-- Bulk SMS job tracking
bulk_send_jobs (
  id           uuid PRIMARY KEY,
  location_id  uuid NOT NULL,
  segment      jsonb NOT NULL,                   -- segment filter as submitted
  body         text NOT NULL,
  status       text NOT NULL DEFAULT 'pending',  -- 'pending' | 'processing' | 'completed' | 'failed'
  total        integer,
  sent         integer NOT NULL DEFAULT 0,
  failed       integer NOT NULL DEFAULT 0,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
)
```

**Indexes:**
- `conversations(location_id, status, last_message_at DESC)` — inbox list query
- `conversations(lead_id, practice_number, last_message_at DESC)` — inbound routing lookup
- `conversation_messages(conversation_id, created_at DESC)` — thread pagination
- `conversation_messages(messaging_message_id)` — delivery status update lookup

---

## 5. Auth & Middleware

The Conversation Service sits behind the CRM API Gateway. The Gateway handles JWT authentication and RBAC for external callers. The service validates incoming requests using a **static shared secret header** (`X-Internal-Api-Key`), not JWTs.

All role/permission checks in the route handler descriptions below refer to the role encoded in the forwarded request context from the Gateway (e.g., `req.user.role`, `req.user.locations`).

### 5.1 Route Guards

| Route | Guard |
|---|---|
| `GET /conversations` | requires `location_id` query param; returns `403` if missing |
| `GET /conversations/:id` | location-scoped access check on resolved conversation |
| `PATCH /conversations/:id` | `conversations:write` permission; `agent_mode_active: true` additionally requires `marketing_manager` role (checked in handler — returns `403` otherwise) |
| `POST /conversations/:id/messages` | `conversations:write` |
| `POST /conversations/:id/scheduled-messages` | `conversations:write` |
| `DELETE /conversations/:id/scheduled-messages/:msg_id` | `conversations:write` |
| `GET /conversations/:id/scheduled-messages` | location-scoped |
| `POST /conversations/:id/notes` | `conversations:write` |
| `DELETE /conversations/:id/notes/:note_id` | `conversations:write` |
| `POST /conversations/:id/read` | any authenticated coordinator |
| `POST /conversations/:id/ai/*` | any authenticated coordinator |
| `POST /bulk-sends` | `requireRole(['call_center_manager', 'marketing_manager', 'super_admin'])` |
| `GET /bulk-sends/:job_id` | location-scoped |
| `GET /settings/locations/:id` | `marketing_manager` or `super_admin` |
| `PATCH /settings/locations/:id` | `marketing_manager` or `super_admin` |

**`@ortho/auth-middleware` update:** Add `bulk-sms:write` to `ROLE_PERMISSIONS` as part of this implementation (granted to `call_center_manager`, `marketing_manager`, `super_admin`). The `POST /bulk-sends` route uses `requireRole` directly (not the permission map) as the guard, but the permission is registered for forward-compatibility.

---

## 6. Environment Variables

```env
# Server
PORT=3006

# Database
DATABASE_URL=postgres://...

# Redis — event bus (RedisStreams driver)
REDIS_URL=redis://...

# Redis — BullMQ queues (separate instance allowed)
BULLMQ_REDIS_URL=redis://...

# EventBridge
EVENT_BUS_NAME=ortho-events
EVENT_BUS_CONSUMER_GROUP=crm-conversation
AWS_REGION=us-east-1

# Internal API key (validated on every inbound request from CRM API Gateway)
INTERNAL_API_KEY=...

# Downstream service base URLs
MESSAGING_SERVICE_URL=http://messaging:3001
LEAD_SERVICE_URL=http://lead:3002
AI_SERVICE_URL=http://ai:3003
AUDIENCE_ENGINE_URL=http://audience:3004
NOTIFICATION_SERVICE_URL=http://notification:3005

# BullMQ worker concurrency (with sensible defaults)
AI_AGENT_CONCURRENCY=5
SCHEDULED_SEND_CONCURRENCY=10
BULK_SEND_CONCURRENCY=1
```

---

## 7. EventBridge Integration

### 7.1 Configuration

- **Consumer group:** `crm-conversation`
- **Single `EventBus` instance** handles both subscribe and publish. Call `bus.subscribe(...)` × 3 before `bus.start()`, then use `bus.publish(...)` in handler code.

### 7.2 Subscribed Events

| Event | Source | Handler |
|---|---|---|
| `inbound_message.received` | Messaging Service | `inbound-message.handler.ts` |
| `message.delivered` | Messaging Service | `message-delivered.handler.ts` |
| `message.failed` | Messaging Service | `message-failed.handler.ts` |

### 7.3 Published Events

| Event | Trigger | Key Payload Fields |
|---|---|---|
| `message.received` | Inbound message processed and stored | `entity_type: "lead"`, `entity_id` (= lead_id), `message_id`, `conversation_id`, `lead_id`, `location_id`, `body`, `message_type`, `from_number`, `practice_number`, `received_at` |

**Published event envelope fields:**
- `event_id`: `randomUUID()` — included on every published event, consistent with all other services
- `correlation_id`: Forwarded from the incoming `inbound_message.received` event envelope (chains the trace)
- `causation_id`: ID of the triggering `inbound_message.received` event
- `schema_version`: `'1.0'` — always set

### 7.4 `@ortho/types` Updates

Add to `packages/@ortho/types/src/events.ts`:

```ts
export interface MessageReceivedPayload {
  entity_type: 'lead';
  entity_id: string;           // = lead_id
  message_id: string;
  conversation_id: string;
  lead_id: string;
  location_id: string;
  body: string;
  message_type: 'normal' | 'stop' | 'unstop';
  from_number: string;
  practice_number: string;
  received_at: string;         // ISO 8601
}

export type MessageReceivedEvent = OrthoEvent<'message.received', MessageReceivedPayload>;
```

---

## 8. BullMQ

### 8.1 Queue Names (service-prefixed)

| Logical name | Queue name |
|---|---|
| AI agent reply | `conversation:ai-agent-reply` |
| Scheduled send | `conversation:scheduled-send` |
| Bulk send | `conversation:bulk-send` |

### 8.2 Worker Concurrency

Driven by env vars with defaults:

| Worker | Env var | Default |
|---|---|---|
| `ai-agent-reply` | `AI_AGENT_CONCURRENCY` | `5` |
| `scheduled-send` | `SCHEDULED_SEND_CONCURRENCY` | `10` |
| `bulk-send` | `BULK_SEND_CONCURRENCY` | `1` |

### 8.3 Graceful Shutdown (SIGTERM)

```ts
process.on('SIGTERM', async () => {
  // Drain in-flight jobs before closing
  await aiAgentWorker.pause(true);
  await scheduledSendWorker.pause(true);
  await bulkSendWorker.pause(true);

  await aiAgentWorker.close();
  await scheduledSendWorker.close();
  await bulkSendWorker.close();

  await bus.stop();
  await db.destroy();
  process.exit(0);
});
```

---

## 9. Inter-Service HTTP Client

Implement a thin shared wrapper **local to this service** (`src/lib/service-client.ts`) that:
- Accepts a `baseUrl` and optional `apiKey`
- Attaches the `X-Internal-Api-Key` header to all requests
- Uses Node.js 24 native `fetch`
- Throws a typed error with `status` and `body` on non-2xx responses

```ts
// src/lib/service-client.ts
export function createServiceClient(baseUrl: string, apiKey: string) {
  return {
    async post<T>(path: string, body: unknown): Promise<T> { ... },
    async get<T>(path: string, params?: Record<string, string>): Promise<T> { ... },
  };
}

// Instantiated once at startup
export const messagingClient = createServiceClient(
  process.env.MESSAGING_SERVICE_URL!, process.env.INTERNAL_API_KEY!
);
export const leadClient = createServiceClient(
  process.env.LEAD_SERVICE_URL!, process.env.INTERNAL_API_KEY!
);
export const aiClient = createServiceClient(
  process.env.AI_SERVICE_URL!, process.env.INTERNAL_API_KEY!
);
export const audienceClient = createServiceClient(
  process.env.AUDIENCE_ENGINE_URL!, process.env.INTERNAL_API_KEY!
);
export const notificationClient = createServiceClient(
  process.env.NOTIFICATION_SERVICE_URL!, process.env.INTERNAL_API_KEY!
);
```

---

## 10. Conversation Model

### 10.1 Identity and Threading

A conversation is keyed by `(lead_id, practice_number)` where `practice_number` is the Twilio number belonging to the practice. One lead can have multiple conversations against the same practice number — a new conversation is created when the most recent conversation for that pair has been inactive for longer than the location's configured `inactivity_days`.

**Inbound routing logic:**

```
inbound_message.received { from_number, to_number, ... }
  → GET /leads?phone={from_number} on Lead Service
      response includes: { id, location_id, phone, current_stage, treatment_interest, ... }
      no match → log warn, skip (unknown number — no conversation created)
  → load location_conversation_settings for lead.location_id
  → SELECT most recent conversation WHERE
        lead_id = resolved_lead_id
    AND practice_number = to_number
    AND last_message_at > now() - inactivity_days
      found → append to existing conversation
      not found → INSERT new conversation (lead_id, location_id=lead.location_id,
                    practice_number=to_number, lead_phone=from_number)
```

### 10.2 Multi-Conversation Per Lead

Each lead can have multiple conversations:
- Different practice numbers (different Twilio tracking numbers)
- Same practice number but separated by inactivity (time-based new thread)

All conversations for a lead are accessible via `GET /conversations?lead_id=uuid`.

---

## 11. API

**Route registration note:** `/bulk-sends` and `/bulk-sends/:job_id` must be registered before `/:id` parameter routes to prevent Fastify from matching the literal string `bulk-sends` as a conversation ID.

**Route prefix:** All routes registered under a `/conversations` Fastify plugin prefix. Service sub-routes become `/conversations/:id/messages`, etc.

**Request validation:** Full TypeBox schemas for all request bodies and response shapes using `@sinclair/typebox` + Fastify's built-in schema validation.

**Error responses:**
- `400` — validation failure: `{ "error": "validation_error", "details": [...] }`
- `403` — permission denied: `{ "error": "forbidden" }`
- `404` — not found: `{ "error": "not_found" }`
- `409` — conflict (e.g., already-sent scheduled message): `{ "error": "conflict" }`
- `422` — business rule violation: `{ "error": "unprocessable", "reason": "..." }`
- `500` — unexpected server failure: `{ "error": "internal_error" }`

### 11.1 Inbox

```
GET /conversations
    ?location_id=uuid&lead_id=uuid&status=open&assigned_to=me&page=1&limit=25
```

Returns conversation list. `location_id` query param is **required** — returns `403` if omitted (no auto-scoping to agent's home location).

Access-scoped by role:
- `call_center_agent` — own location only
- `call_center_manager` — assigned locations
- `marketing_manager` / `super_admin` — all locations

Response shape per item:
```json
{
  "id": "uuid",
  "lead_id": "uuid",
  "location_id": "uuid",
  "practice_number": "+15551234567",
  "lead_phone": "+15559876543",
  "status": "open",
  "assigned_to": "uuid | null",
  "escalated": false,
  "agent_mode_active": false,
  "last_message_at": "2026-03-25T10:00:00Z",
  "last_message_preview": "Hey I had a question about...",
  "unread_count": 3
}
```

`unread_count` = count of `conversation_messages` where `created_at` is after the `created_at` of `conversation_reads.last_read_message_id` for the calling user (subquery on primary key). If no read record exists, `unread_count` = total message count.

`last_message_preview` = `body` of the most recent `conversation_messages` row (by `created_at DESC`), truncated to 80 characters. Fetched via JOIN — not a stored column.

```
GET /conversations/:id
```
Returns conversation detail + most recent 50 messages + notes.

```
GET /conversations/:id/messages?before=uuid&limit=50
```
Paginated thread, cursor-based (newest-first).

```
PATCH /conversations/:id
      { assigned_to?, escalated?, status?, agent_mode_active? }
```

One endpoint guarded by `conversations:write` permission. Handler logic:
- `agent_mode_active: true` — additionally requires `req.user.role === 'marketing_manager'`; returns `403` otherwise. When re-enabling, resets `agent_exchange_count` to `0`.
- `assigned_to` — any coordinator role; once set, AI agent stops handling new inbound messages for this conversation
- `agent_mode_active: false` — any coordinator role (disable agent for this conversation)
- `status: 'closed'` / `'open'` — any coordinator role

**Conversation status and inbound routing:** `status = 'closed'` is a UI-layer signal only — it does not block inbound message append. If a lead replies to a closed conversation within the `inactivity_days` window, the message is appended and the conversation is automatically set back to `status = 'open'`. If the inactivity window has expired, a new conversation is created regardless of the closed conversation's status.

```
POST /conversations/:id/read
```
Upserts `conversation_reads` for calling user, setting `last_read_message_id` to the most recent message in the conversation at the time of the call.

### 11.2 Outbound & Scheduled

```
POST /conversations/:id/messages
     { body, media_url? }
```
Sends immediately via Messaging Service. If `agent_mode_active = true`, disables agent mode (human takes over). Returns `200 { message_id, status: 'queued' }`.

```
POST /conversations/:id/scheduled-messages
     { body, media_url?, scheduled_for }
```
Creates a pending scheduled send and enqueues a BullMQ delayed job. Returns `201 { scheduled_message_id }`.

```
DELETE /conversations/:id/scheduled-messages/:msg_id
```
Cancels a pending scheduled send: updates `status = 'cancelled'` in DB and removes the BullMQ job via `job.remove()`. Returns `409` if already sent.

```
GET /conversations/:id/scheduled-messages
```
Lists pending scheduled sends for the conversation.

### 11.3 Notes

```
POST   /conversations/:id/notes          { body }
DELETE /conversations/:id/notes/:note_id
```
Internal notes are visible to all staff at the location. Not visible to leads.

### 11.4 AI Features

All AI features call `POST /ai/complete` on the AI Service. Prompt IDs below must be registered in the AI Service prompt registry (`apps/platform/ai/src/prompts/`) — see Section 14.

```
POST /conversations/:id/ai/drafts
```
Returns 2-3 reply draft options. Calls AI Service with `prompt_id: "conversation-reply-drafts"`, context includes last 10 messages + lead stage + treatment interest.
Response: `{ drafts: [{ body, label }] }`

```
POST /conversations/:id/ai/summary
```
Returns a 3-sentence conversation briefing. Calls AI Service with `prompt_id: "conversation-summary"`. Triggered when coordinator opens a thread with 10+ messages.
Response: `{ summary }`

```
POST /conversations/:id/ai/objection
     { objection_type }
```
Returns objection handling strategies. Calls AI Service with `prompt_id: "conversation-objection-handling"`.
Response: `{ strategies: [{ title, body }] }`

### 11.5 Bulk SMS

```
POST /bulk-sends
     { segment: { ...audience filter fields... }, body, location_id }
```
Guarded by `requireRole(['call_center_manager', 'marketing_manager', 'super_admin'])`.
Enqueues a BullMQ bulk-send job. Returns `202 { job_id }`.

Access:
- `call_center_manager` — own location only
- `marketing_manager` — all locations

```
GET /bulk-sends/:job_id
    → { status, total, sent, failed }
```

### 11.6 Location Settings

```
GET   /settings/locations/:id
PATCH /settings/locations/:id
      { inactivity_days?, agent_mode_enabled?, agent_max_exchanges?, location_phone?, practice_number? }
```
`marketing_manager` role only.

**Validation:** `PATCH` with `agent_mode_enabled: true` returns `422` if `location_phone` is not already set and not provided in the same request. Similarly, `422` if `practice_number` is not already set.

`practice_number` is also used as the `from_number` for bulk SMS sends.

---

## 12. Key Flows

### 12.1 Inbound Message Flow

```
EventBridge: inbound_message.received
  → SQS → inbound-message.handler.ts
  → GET /leads?phone={from_number} on Lead Service
      response: { id, location_id, phone, current_stage, treatment_interest, ... }
      no match → log warn, return (unknown number — no conversation created)
  → load location_conversation_settings for lead.location_id
  → find or create conversation:
      SELECT most recent conversation WHERE lead_id = ? AND practice_number = to_number
        AND last_message_at > now() - inactivity_days
        → found (any status): append + if status = 'closed' → set status = 'open'
        → not found: INSERT new conversation
  → INSERT conversation_messages (direction: 'inbound', status: 'received',
      message_type from event, messaging_message_id from event.message_id)
  → UPDATE conversations SET last_message_at = now()
  → publish message.received to EventBridge:
      envelope: {
        event_id: randomUUID(),
        correlation_id: <forwarded from inbound_message.received envelope>,
        causation_id: <inbound_message.received event_id>,
        schema_version: '1.0'
      }
      payload: {
        entity_type: 'lead', entity_id: lead.id,
        message_id, conversation_id, lead_id: lead.id, location_id: lead.location_id,
        body, message_type, from_number, practice_number: to_number, received_at
      }
  → POST /notifications/publish:
      { channel: 'location:{location_id}:conversations',
        payload: { type: 'inbound_message', conversation_id, lead_id: lead.id, preview: body[:80] } }
  → if message_type != 'normal':
      skip AI agent processing (STOP/UNSTOP are opt-out commands, not conversational replies)
      return
  → if agent_mode_enabled AND conversation.agent_mode_active
                           AND conversation.assigned_to IS NULL
                           AND NOT conversation.escalated:
      if agent_exchange_count >= agent_max_exchanges:
        UPDATE conversations SET escalated = true
        POST /notifications/publish { type: 'agent_escalation', conversation_id }
      else:
        enqueue BullMQ job 'conversation:ai-agent-reply' { conversation_id, trigger_message_id }
```

**Note:** `message.delivered` / `message.failed` events are published by Messaging Service for all outbound messages system-wide. The delivery status handler updates `conversation_messages` by `messaging_message_id`. When no matching row is found (message owned by another service — Automation Engine, Nurturing Engine, etc.), the handler silently no-ops — this is expected behavior.

### 12.2 Outbound Send Flow (Coordinator)

```
POST /conversations/:id/messages { body }
  → load conversation — verify JWT location access
  → if conversation.agent_mode_active:
      UPDATE conversations SET agent_mode_active = false
  → POST /messages/send on Messaging Service:
      { to: conversation.lead_phone,
        from_number: conversation.practice_number,
        body,
        dedup_key: new uuid }
  → INSERT conversation_messages:
      { direction: 'outbound', author_id: jwt.sub,
        status: 'queued', messaging_message_id: response.message_id }
  → UPDATE conversations SET last_message_at = now()
  → return 200 { message_id, status: 'queued' }
```

### 12.3 Delivery Status Update Flow

```
EventBridge: message.delivered
  → UPDATE conversation_messages SET status = 'delivered', delivered_at = event.delivered_at
      WHERE messaging_message_id = event.message_id
  (no rows matched = message owned by another service — silent no-op)

EventBridge: message.failed
  → UPDATE conversation_messages SET status = 'failed'
      WHERE messaging_message_id = event.message_id
  (no rows matched = silent no-op)
```

### 12.4 AI Agent Reply Flow

The `conversation-agent-reply` prompt instructs Claude to return structured JSON in `response.text`:
```json
{ "text": "reply body here", "escalate": false }
```
or
```json
{ "text": "", "escalate": true, "reason": "clinical_question" }
```
If `response.text` cannot be parsed as valid JSON, the worker treats it as an escalation (fail-safe).

```
BullMQ job: conversation:ai-agent-reply { conversation_id, trigger_message_id }
  → load conversation + last 10 messages
  → load settings = location_conversation_settings for conversation.location_id
  → GET /leads/:lead_id on Lead Service (for context: name, stage, treatment interest)
  → POST /ai/complete {
        prompt_id: 'conversation-agent-reply',
        context: { lead_name, lead_stage, treatment_interest,
                   location_name, recent_messages }
    }
  → parse response.text as JSON → { text, escalate, reason? }
      parse failure OR escalate = true:
        UPDATE conversations SET escalated = true, agent_mode_active = false
        POST /notifications/publish { channel: 'location:{id}:conversations',
                                       payload: { type: 'agent_escalation', conversation_id } }
        return
  → POST /messages/send on Messaging Service:
      { to: conversation.lead_phone,
        from_number: conversation.practice_number,
        body: text + '\n\n' + disclosure_footer(settings.location_phone),
        dedup_key: 'agent:' + conversation_id + ':' + conversation.agent_exchange_count }
  → INSERT conversation_messages (is_agent: true, status: 'queued')
  → UPDATE conversations SET agent_exchange_count += 1, last_message_at = now()
```

Disclosure footer: `"This message was sent automatically. Reply STOP to opt out or call us at {location_phone} to speak with our team."`

### 12.5 Scheduled Send Flow

```
POST /conversations/:id/scheduled-messages { body, scheduled_for }
  → INSERT scheduled_messages (status: 'pending')
  → enqueue BullMQ delayed job 'conversation:scheduled-send',
      delay = scheduled_for - now()
      job data: { scheduled_message_id }

DELETE /conversations/:id/scheduled-messages/:msg_id
  → UPDATE scheduled_messages SET status = 'cancelled' (if status = 'pending')
  → call job.remove() on the BullMQ job
      if job already executing → worker's idempotency guard (status != 'pending') skips send
  → 409 if status was already 'sent'

BullMQ job: conversation:scheduled-send { scheduled_message_id }
  → load scheduled_message — verify status = 'pending' (idempotency guard; 'cancelled' → skip)
  → POST /messages/send on Messaging Service
  → INSERT conversation_messages
  → UPDATE scheduled_messages SET status = 'sent', sent_at = now()
```

### 12.6 Bulk SMS Flow

The Audience Engine uses a hybrid push model — callers must provide entity data; the engine never fetches it independently.

**Cross-spec dependency:** This flow requires `GET /leads?location_id={id}&status=active` with cursor-based pagination on the Lead Service. This endpoint is not yet in the Lead Service spec and must be added. Required response fields per lead: `id`, `location_id`, `phone`, plus any filterable fields the Audience Engine segment may reference (e.g., `current_stage`, `current_pipeline`, `created_at`, `tags`).

```
BullMQ job: conversation:bulk-send { job_id, segment, body, location_id }
  → UPDATE bulk_send_jobs SET status = 'processing'
  → paginate through GET /leads?location_id={location_id}&status=active on Lead Service
      (fetch all candidate leads with filter fields required by segment)
      → accumulate lead objects in Map<lead_id, lead> (phone + filter fields in memory)
  → POST /audiences/evaluate {
        filter: segment,
        entities: [{ id: lead.id, ...lead fields used in filter }],
        snapshot: false
    }
    → returns matched lead IDs
  → UPDATE bulk_send_jobs SET total = matched_lead_ids.length
  → for each matched lead_id (batched):
      → phone = leadMap.get(lead_id).phone   ← reuse from paginate step, no re-fetch
      → POST /messages/send on Messaging Service
          { to: phone, from_number: settings.practice_number, body,
            dedup_key: job_id + ':' + lead_id }
      → increment sent or failed counter
  → UPDATE bulk_send_jobs SET status = 'completed', sent = N, failed = M
```

---

## 13. AI Agent Mode

### 13.1 Configuration

Agent mode is a **location-level setting** (`location_conversation_settings.agent_mode_enabled`). When enabled, all new inbound messages on unassigned, non-escalated conversations at that location are handled autonomously by the AI until a human takes over or escalation triggers.

Configurable per location:
- `agent_mode_enabled` — on/off (default: false)
- `agent_max_exchanges` — max autonomous back-and-forth before forced escalation (default: 3)
- `location_phone` — practice phone number used in disclosure footer

### 13.2 Escalation Conditions

| Condition | Mechanism |
|---|---|
| `agent_exchange_count >= agent_max_exchanges` | Checked in inbound handler before enqueueing job |
| AI returns `escalate: true` in structured response | Checked in BullMQ worker after AI Service call |
| `response.text` fails JSON parse | BullMQ worker fail-safe — treats parse failure as escalation |
| `message_type = 'stop'` or `'unstop'` | Inbound handler skips AI entirely for opt-out commands |

On escalation: `conversations.escalated = true`, `agent_mode_active = false`, escalation notification pushed to location channel.

### 13.3 Human Takeover

- **Manual send** (`POST /conversations/:id/messages`): sets `agent_mode_active = false` immediately.
- **Coordinator assignment** (`PATCH /conversations/:id { assigned_to }`): once `assigned_to IS NOT NULL`, the inbound handler does not enqueue AI agent jobs regardless of `agent_mode_enabled`.
- **Re-enable**: `marketing_manager` can set `agent_mode_active: true` via `PATCH /conversations/:id`. When re-enabling, `agent_exchange_count` is reset to `0`.
- Any coordinator can set `agent_mode_active: false` (disable) via `PATCH /conversations/:id`.

---

## 14. AI Service Prompt Requirements

The following prompts must be registered as part of this service's implementation in `apps/platform/ai/src/prompts/`:

| prompt_id | Purpose | Expected `response.text` format |
|---|---|---|
| `conversation-reply-drafts` | Smart reply options | JSON array: `[{ "body": "...", "label": "..." }]` |
| `conversation-summary` | 3-sentence thread summary | Plain text |
| `conversation-objection-handling` | Strategy options for objections | JSON array: `[{ "title": "...", "body": "..." }]` |
| `conversation-agent-reply` | Autonomous agent response | JSON object: `{ "text": "...", "escalate": boolean, "reason"?: string }` |

---

## 15. Read Receipts

Two distinct mechanisms:

| Type | Source | Storage |
|---|---|---|
| Twilio delivery status | `message.delivered` EventBridge event | `conversation_messages.status`, `delivered_at` |
| Coordinator "seen" (in-app) | `POST /conversations/:id/read` | `conversation_reads (conversation_id, user_id, last_read_message_id)` |

**Unread count** (cursor-based): count of `conversation_messages` where `created_at >` the `created_at` of `last_read_message_id`. If no `conversation_reads` row exists for the user, all messages in the conversation are unread.

---

## 16. Logging

### 16.1 HTTP Request Logger

Bind child logger fields as they become available across the request lifecycle:

```ts
// At handler entry
const log = req.log.child({ requestId: req.id, locationId: req.query.location_id });

// Once conversation is resolved
const log = log.child({ conversationId: conversation.id });
```

Fields: `{ requestId, conversationId, locationId }` — bind all available IDs as they are known.

### 16.2 BullMQ Worker Logger

```ts
// At job start
const log = logger.child({ jobId: job.id, conversationId: job.data.conversation_id });

// As additional IDs resolve
log = log.child({ leadId: lead.id });
log = log.child({ messagingMessageId: response.message_id });
```

Fields: `{ jobId, conversationId }` at job start; add `leadId`, `messagingMessageId` as they resolve.

---

## 17. Service Layout

```
apps/crm/conversation/
├── src/
│   ├── routes/
│   │   ├── bulk-sends.ts           # POST /bulk-sends, GET /bulk-sends/:job_id (registered first)
│   │   ├── conversations.ts        # GET /conversations, GET/PATCH /:id, POST /:id/read
│   │   ├── messages.ts             # GET /:id/messages, POST /:id/messages
│   │   ├── notes.ts                # POST/DELETE /:id/notes/:note_id
│   │   ├── scheduled.ts            # POST/GET/DELETE /:id/scheduled-messages
│   │   ├── ai.ts                   # POST /:id/ai/drafts|summary|objection
│   │   └── settings.ts             # GET/PATCH /settings/locations/:id
│   ├── services/
│   │   ├── conversation-resolver.ts   # find-or-create logic (inactivity window)
│   │   ├── outbound-sender.ts         # coordinator send → Messaging Service
│   │   ├── ai-features.ts             # drafts / summary / objection → AI Service
│   │   ├── agent-mode.ts              # escalation evaluation, JSON parse, disclosure footer
│   │   └── bulk-sender.ts             # Lead Service → Audience Engine → Messaging Service
│   ├── repositories/
│   │   ├── conversations.repo.ts
│   │   ├── messages.repo.ts
│   │   ├── notes.repo.ts
│   │   ├── reads.repo.ts
│   │   ├── scheduled.repo.ts
│   │   ├── bulk-send-jobs.repo.ts
│   │   └── settings.repo.ts
│   ├── events/
│   │   ├── handlers/
│   │   │   ├── inbound-message.handler.ts
│   │   │   ├── message-delivered.handler.ts
│   │   │   └── message-failed.handler.ts
│   │   └── publisher.ts            # message.received → EventBridge
│   ├── workers/
│   │   ├── ai-agent-reply.worker.ts   # autonomous AI response
│   │   ├── scheduled-send.worker.ts   # delayed coordinator send
│   │   └── bulk-send.worker.ts        # bulk SMS batch processing
│   ├── lib/
│   │   └── service-client.ts          # thin HTTP wrapper for inter-service calls
│   └── index.ts
├── migrations/
│   └── 20260325000000_create_conversations.ts   # timestamp-prefix convention
├── test/
│   ├── unit/
│   ├── integration/
│   └── contract/
├── Dockerfile
├── package.json                    # name: "@crm/conversation"
└── tsconfig.json
```

**Runtime dependencies:**
- PostgreSQL (`crm_conversations` schema, `searchPath: 'crm_conversations'`)
- Redis (`REDIS_URL` for event bus, `BULLMQ_REDIS_URL` for BullMQ queues)
- AWS EventBridge (consumer group `crm-conversation`; subscribe + publish via single `EventBus` instance)
- Messaging Service (`MESSAGING_SERVICE_URL`)
- Lead Service (`LEAD_SERVICE_URL`)
- AI Service (`AI_SERVICE_URL`)
- Audience Engine (`AUDIENCE_ENGINE_URL`)
- Notification Service (`NOTIFICATION_SERVICE_URL`)

---

## 18. Testing Strategy

### 18.1 Unit Tests (Vitest)

Pure functions and isolated logic:

- **conversation-resolver.ts:** find existing conversation within inactivity window; create new when expired; create new when none exists; correct `(lead_id, practice_number)` key matching
- **agent-mode.ts:** escalation threshold check (exchange count); JSON parse failure → escalate; `escalate: true` in parsed response → escalate; valid non-escalating response → send; `message_type = 'stop'` → skip AI; human takeover clears `agent_mode_active`; disclosure footer appended correctly with `location_phone`
- **outbound-sender.ts:** agent mode disabled on manual send; dedup_key generated per send

### 18.2 Integration Tests (Vitest + real Postgres + real Redis)

**DB setup:** Each test file spins up its own schema via Knex migrations in `beforeAll`, drops it in `afterAll` — matches Pipeline Engine pattern.

**HTTP mocking:** `nock` — intercept Node.js `http`/`https` at the module level for all downstream service calls.

**BullMQ workers:** Call the worker's internal handler function directly — bypass the BullMQ queue and test business logic. Do not use a real BullMQ queue in integration tests.

Test scenarios:
- **Inbound happy path** — `inbound_message.received` → lead resolved → conversation found → message stored → `message.received` published with `entity_type: "lead"` → notification sent
- **Inbound new conversation** — inactivity expired → new conversation created, old conversation untouched
- **Inbound unknown phone** — lead not found → no conversation created, no event published, warn logged
- **Inbound STOP message** — `message_type: 'stop'` → stored in thread → AI agent NOT enqueued regardless of agent_mode_enabled
- **Inbound agent mode** — agent enabled, unassigned, not escalated → BullMQ job enqueued; coordinator assigned → no job enqueued
- **Inbound escalation** — `agent_exchange_count >= agent_max_exchanges` → escalated = true, no job enqueued, escalation notification sent
- **Outbound send** — coordinator POST → Messaging Service called → message inserted with `status: queued`
- **Outbound disables agent** — `agent_mode_active = true` → send → `agent_mode_active = false`
- **Delivery update** — `message.delivered` event → `conversation_messages.status` updated to `delivered`
- **Delivery update for unknown message_id** — no rows matched → handler completes without error (silent no-op)
- **AI agent reply** — BullMQ job (handler called directly) → AI Service called → JSON parsed → Messaging Service called → message inserted `is_agent: true`, `agent_exchange_count` incremented
- **AI agent escalation (escalate: true)** — AI returns `{ escalate: true }` → Messaging Service NOT called → `escalated = true`
- **AI agent escalation (parse failure)** — AI returns non-JSON → treated as escalation → `escalated = true`
- **Scheduled send** — create → BullMQ delayed job → fires at `scheduled_for` → Messaging Service called → status `sent`
- **Scheduled send cancel** — cancel before fire → status `cancelled`, job removed → worker skips (idempotency guard)
- **Read tracking** — POST /read → upserts `conversation_reads` with `last_read_message_id`; unread_count = 0 after read
- **PATCH agent_mode_active: true** — requires `marketing_manager` role; coordinator role → 403

### 18.3 Contract Tests (`test/contract/`)

- `message.received` event payload matches `@ortho/event-bus` schema; includes `entity_type: "lead"` and `entity_id`; includes `event_id`, `correlation_id`, `schema_version: '1.0'`
- Messaging Service call shape: `to`, `from_number`, `body`, `dedup_key` all present
- AI Service call shape for `conversation-agent-reply`: `prompt_id`, `context` present; `response.text` parseable as `{ text, escalate }` JSON

---

## 19. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Auth model | Static API key (behind CRM API Gateway) | Gateway handles JWT + RBAC; service-to-service calls use shared secret only — consistent with other product services |
| Package name | `@crm/conversation` | Scoped to CRM product layer; consistent with `@crm/*` naming for product services |
| Knex setup | Direct `knex` + `pg` with `searchPath: 'crm_conversations'` | No `@ortho/db` package yet; unqualified table names keep queries clean |
| Migration naming | Timestamp prefix | Consistent with Pipeline Engine pattern |
| BullMQ Redis | Separate `BULLMQ_REDIS_URL` | Allows independent scaling; event bus and job queue can be on different Redis instances |
| BullMQ queue names | `conversation:` prefixed | Avoids collision with other services on shared Redis |
| BullMQ concurrency | Env-var driven with defaults | Operational flexibility without code changes |
| BullMQ shutdown | `pause(true)` then `close()` | Drains in-flight jobs before exiting; safer than immediate close |
| HTTP client | Local thin wrapper using native `fetch` | No extra dependency; handles base URL + auth header in one place |
| Inter-service URLs | Separate env var per service | Clear, debuggable; no magic path-prefix convention |
| EventBus instance | Single instance for pub + sub | Matches Pipeline Engine pattern; one `bus.start()` call manages all |
| `event_id` on publish | `randomUUID()` always | Consistent with all other published events across services |
| `correlation_id` on publish | Forward from incoming event | Chains the distributed trace through inbound → outbound → Automation Engine |
| `schema_version` on publish | `'1.0'` always | Enables future schema evolution without breaking consumers |
| `@ortho/types` update | Add `MessageReceivedPayload` + `MessageReceivedEvent` | Typed event contract for Automation Engine and other consumers |
| TypeBox schemas | Full schemas for all request/response | Consistent with all other services; schema-level validation before handler runs |
| `GET /conversations` `location_id` | Required param → 403 if missing | No silent auto-scoping; explicit is safer in a multi-location system |
| `PATCH` `agent_mode_active: true` | Role check in handler | Single endpoint is simpler; `403` path is a rare operation |
| `/bulk-sends` guard | `requireRole` (not permission map) | Permission `bulk-sms:write` added to middleware for future use, but route uses role directly |
| BullMQ integration tests | Call handler directly | Tests business logic without Redis dependency in CI; queue mechanics tested separately |
| HTTP mocking | `nock` | Matches existing test patterns in the codebase |
| Contract tests | `test/contract/` folder | Consistent with Pipeline Engine pattern |
| AI prompts | Registered in `apps/platform/ai/src/prompts/` | In-scope for this implementation; AI Service is a dependency that must be ready |
| Message storage | Conversation Service owns its own copy | Self-contained inbox reads; CS-specific fields (conversation_id, read state, is_agent); SOA autonomy |
| Conversation keying | `(lead_id, practice_number)` + time-based inactivity reset | Matches real-world SMS threading |
| Agent mode scope | Location-level on/off | Simpler than per-sequence-step activation |
| Agent mode processing | BullMQ job (async) | Avoids blocking SQS handler; retry semantics; timeout-safe AI calls |

---

## 20. Pending Amendments

- **Lead Service spec** must add: `GET /leads?location_id={id}&status=active` with cursor-based pagination, returning at minimum `{ id, location_id, phone, current_stage, current_pipeline, created_at, tags }` — required by the bulk SMS worker.
- **`@ortho/auth-middleware`** must add `bulk-sms:write` to `ROLE_PERMISSIONS` for `call_center_manager`, `marketing_manager`, `super_admin`.
