# Conversation Service — Design Spec

**Date:** 2026-03-25
**Status:** Draft
**Scope:** Product-layer Conversation Service — shared SMS inbox, conversation threading, coordinator workflow, AI features, AI Agent autonomous mode

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
- Bulk SMS: BullMQ batch job calling Audience Engine + Lead Service + Messaging Service
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
Coordinator ──────► │  REST API                                        │
 (browser)          │    ├── conversations  (inbox list, thread)       │
                    │    ├── messages       (send, read receipt)       │
                    │    ├── notes          (internal notes)           │
                    │    ├── scheduled      (scheduled sends)          │
                    │    ├── ai             (drafts, summary, objection)│
                    │    ├── bulk-send      (segment broadcast)        │
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

## 3. Conversation Model

### 3.1 Identity and Threading

A conversation is keyed by `(lead_id, practice_number)` where `practice_number` is the Twilio number belonging to the practice. One lead can have multiple conversations against the same practice number — a new conversation is created when the most recent conversation for that pair has been inactive for longer than the location's configured `inactivity_days`.

**Inbound routing logic:**

```
inbound_message.received { from_number, to_number, ... }
  → GET /leads?phone={from_number} on Lead Service
      no match → log warn, skip (unknown number)
  → load location_conversation_settings for lead's location_id
  → SELECT most recent conversation WHERE
        lead_id = resolved_lead_id
    AND practice_number = to_number
    AND last_message_at > now() - inactivity_days
      found → append to existing conversation
      not found → INSERT new conversation
```

### 3.2 Multi-Conversation Per Lead

Each lead can have multiple conversations:
- Different practice numbers (different Twilio tracking numbers)
- Same practice number but separated by inactivity (time-based new thread)

All conversations for a lead are accessible via `GET /conversations?lead_id=uuid`.

---

## 4. API

### 4.1 Inbox

```
GET /conversations
    ?location_id=uuid&lead_id=uuid&status=open&assigned_to=me&page=1&limit=25
```
Returns conversation list with `unread_count` per conversation and last message preview. Access-scoped by JWT:
- `call_center_agent` — own location only
- `call_center_manager` — assigned locations
- `marketing_manager` / `super_admin` — all locations

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
- `assigned_to` — any coordinator role
- `agent_mode_active` — `marketing_manager` role only
- `status: 'closed'` — closes conversation

```
POST /conversations/:id/read
```
Upserts `conversation_reads` for calling user (marks conversation as read up to the latest message).

### 4.2 Outbound & Scheduled

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
Cancels a pending scheduled send. Returns `409` if already sent.

```
GET /conversations/:id/scheduled-messages
```
Lists pending scheduled sends for the conversation.

### 4.3 Notes

```
POST   /conversations/:id/notes          { body }
DELETE /conversations/:id/notes/:note_id
```
Internal notes are visible to all staff at the location. Not visible to leads.

### 4.4 AI Features

```
POST /conversations/:id/ai/drafts
```
Returns 2-3 reply draft options. Calls AI Service with `prompt_id: conversation_reply_drafts`, context includes last 10 messages + lead stage + treatment interest.
Response: `{ drafts: [{ body, label }] }`

```
POST /conversations/:id/ai/summary
```
Returns a 3-sentence conversation briefing. Calls AI Service with `prompt_id: conversation_summary`. Triggered when coordinator opens a thread with 10+ messages.
Response: `{ summary }`

```
POST /conversations/:id/ai/objection
     { objection_type }
```
Returns objection handling strategies. Calls AI Service with `prompt_id: conversation_objection_handling`.
Response: `{ strategies: [{ title, body }] }`

### 4.5 Bulk SMS

```
POST /conversations/bulk-send
     { segment: { ...audience filter fields... }, body, location_id }
```
Enqueues a BullMQ bulk-send job. Calls Audience Engine (`POST /audiences/evaluate`) to resolve lead IDs, then Lead Service for phone numbers, then Messaging Service per recipient. Returns `202 { job_id }`.

- `call_center_manager` — own location only
- `marketing_manager` — all locations

```
GET /conversations/bulk-send/:job_id
    → { status, total, sent, failed }
```

### 4.6 Location Settings

```
GET   /settings/locations/:id
PATCH /settings/locations/:id
      { inactivity_days?, agent_mode_enabled?, agent_max_exchanges? }
```
`marketing_manager` role only.

---

## 5. Key Flows

### 5.1 Inbound Message Flow

```
EventBridge: inbound_message.received
  → SQS → inbound-message.handler.ts
  → GET /leads?phone={from_number} on Lead Service
      no match → log warn, return (unknown number — no conversation created)
  → load location_conversation_settings for lead's location_id
  → find or create conversation (lead_id, practice_number=to_number, inactivity window)
  → INSERT conversation_messages (direction: 'inbound', status: 'received',
      message_type from event, messaging_message_id from event.message_id)
  → UPDATE conversations SET last_message_at = now()
  → publish message.received to EventBridge:
      { message_id, conversation_id, lead_id, location_id, body,
        message_type, from_number, practice_number: to_number, received_at }
  → POST /notifications/publish:
      { channel: 'location:{location_id}:conversations',
        payload: { type: 'inbound_message', conversation_id, lead_id, preview: body[:80] } }
  → if agent_mode_enabled AND conversation.assigned_to IS NULL
                           AND NOT conversation.escalated:
      if agent_exchange_count >= agent_max_exchanges:
        UPDATE conversations SET escalated = true
        POST /notifications/publish (type: 'agent_escalation')
      else:
        enqueue BullMQ job 'ai-agent-reply' { conversation_id, trigger_message_id }
```

### 5.2 Outbound Send Flow (Coordinator)

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

### 5.3 Delivery Status Update Flow

```
EventBridge: message.delivered
  → UPDATE conversation_messages SET status = 'delivered', delivered_at = event.delivered_at
      WHERE messaging_message_id = event.message_id

EventBridge: message.failed
  → UPDATE conversation_messages SET status = 'failed'
      WHERE messaging_message_id = event.message_id
```

### 5.4 AI Agent Reply Flow

```
BullMQ job: ai-agent-reply { conversation_id, trigger_message_id }
  → load conversation + last 10 messages
  → GET /leads/:lead_id on Lead Service (for context: name, stage, treatment interest)
  → POST /ai/complete {
        prompt_id: 'conversation_agent_reply',
        context: { lead_name, lead_stage, treatment_interest,
                   location_name, recent_messages }
    }
  → evaluate response:
      if confidence < 0.7 OR clinical keyword detected:
        UPDATE conversations SET escalated = true, agent_mode_active = false
        POST /notifications/publish { type: 'agent_escalation', conversation_id }
        return
  → POST /messages/send on Messaging Service:
      { body: response.text + '\n\n' + disclosure_footer }
  → INSERT conversation_messages (is_agent: true, status: 'queued')
  → UPDATE conversations SET agent_exchange_count += 1, last_message_at = now()
```

Disclosure footer: `"This message was sent automatically. Reply STOP to opt out or call us at [location_phone] to speak with our team."`

### 5.5 Scheduled Send Flow

```
POST /conversations/:id/scheduled-messages { body, scheduled_for }
  → INSERT scheduled_messages (status: 'pending')
  → enqueue BullMQ delayed job 'scheduled-send',
      delay = scheduled_for - now()

BullMQ job: scheduled-send { scheduled_message_id }
  → load scheduled_message — verify status = 'pending' (idempotency guard)
  → POST /messages/send on Messaging Service
  → INSERT conversation_messages
  → UPDATE scheduled_messages SET status = 'sent', sent_at = now()
```

---

## 6. AI Agent Mode

### 6.1 Configuration

Agent mode is a **location-level setting** (`location_conversation_settings.agent_mode_enabled`). When enabled, all new inbound messages on unassigned conversations at that location are handled autonomously by the AI until a human takes over or escalation triggers.

Configurable per location:
- `agent_mode_enabled` — on/off (default: false)
- `agent_max_exchanges` — max autonomous back-and-forth before forced escalation (default: 3)

### 6.2 Escalation Conditions

Any of the following triggers escalation (human takeover):

| Condition | Mechanism |
|---|---|
| `agent_exchange_count >= agent_max_exchanges` | Checked in inbound handler before enqueueing job |
| AI confidence below 0.7 | Checked in BullMQ worker after AI Service response |
| Clinical keyword detected in AI response | Checked in BullMQ worker |

On escalation: `conversations.escalated = true`, `agent_mode_active = false`, notification pushed to location channel.

### 6.3 Human Takeover

When a coordinator manually sends a message via `POST /conversations/:id/messages`, `agent_mode_active` is set to `false` immediately. The AI agent will not process subsequent inbound messages for that conversation until re-enabled.

---

## 7. Read Receipts

Two distinct mechanisms:

| Type | Source | Storage |
|---|---|---|
| Twilio delivery status | `message.delivered` EventBridge event | `conversation_messages.status`, `delivered_at` |
| Coordinator "seen" (in-app) | `POST /conversations/:id/read` | `conversation_reads (conversation_id, user_id, last_read_message_id)` |

**Unread count** = count of `conversation_messages` with `created_at > conversation_reads.read_at` for the calling user (or total message count if no read record exists).

---

## 8. EventBridge Events

### Published

| Event | Trigger | Key Payload Fields |
|---|---|---|
| `message.received` | Inbound message processed and stored | `message_id`, `conversation_id`, `lead_id`, `location_id`, `body`, `message_type`, `from_number`, `practice_number`, `received_at` |

### Subscribed

| Event | Source | Handler |
|---|---|---|
| `inbound_message.received` | Messaging Service | `inbound-message.handler.ts` |
| `message.delivered` | Messaging Service | `message-delivered.handler.ts` |
| `message.failed` | Messaging Service | `message-failed.handler.ts` |

---

## 9. Database Schema — `crm_conversations`

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
  last_read_message_id uuid,
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
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
)

-- Per-location inbox configuration
location_conversation_settings (
  location_id          uuid PRIMARY KEY,
  inactivity_days      integer NOT NULL DEFAULT 30,
  agent_mode_enabled   boolean NOT NULL DEFAULT false,
  agent_max_exchanges  integer NOT NULL DEFAULT 3,
  updated_at           timestamptz NOT NULL DEFAULT now()
)
```

**Indexes:**
- `conversations(location_id, status, last_message_at DESC)` — inbox list query
- `conversations(lead_id, practice_number, last_message_at DESC)` — inbound routing lookup
- `conversation_messages(conversation_id, created_at DESC)` — thread pagination
- `conversation_messages(messaging_message_id)` — delivery status update lookup

---

## 10. Service Layout

```
apps/crm/conversation/
├── src/
│   ├── routes/
│   │   ├── conversations.ts        # GET /conversations, GET/PATCH /:id, POST /:id/read
│   │   ├── messages.ts             # GET /:id/messages, POST /:id/messages
│   │   ├── notes.ts                # POST/DELETE /:id/notes/:note_id
│   │   ├── scheduled.ts            # POST/GET/DELETE /:id/scheduled-messages
│   │   ├── ai.ts                   # POST /:id/ai/drafts|summary|objection
│   │   ├── bulk-send.ts            # POST /bulk-send, GET /bulk-send/:job_id
│   │   └── settings.ts             # GET/PATCH /settings/locations/:id
│   ├── services/
│   │   ├── conversation-resolver.ts   # find-or-create logic (inactivity window)
│   │   ├── outbound-sender.ts         # coordinator send → Messaging Service
│   │   ├── ai-features.ts             # drafts / summary / objection → AI Service
│   │   ├── agent-mode.ts              # escalation evaluation, disclosure footer
│   │   └── bulk-sender.ts             # Audience Engine → Lead Service → Messaging Service
│   ├── repositories/
│   │   ├── conversations.repo.ts
│   │   ├── messages.repo.ts
│   │   ├── notes.repo.ts
│   │   ├── reads.repo.ts
│   │   ├── scheduled.repo.ts
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
│   └── index.ts
├── migrations/
├── test/
├── Dockerfile
├── package.json
└── tsconfig.json
```

**Runtime dependencies:**
- PostgreSQL (`crm_conversations` schema)
- Redis (BullMQ — ai-agent-reply, scheduled-send, bulk-send queues)
- AWS EventBridge (subscribe + publish)
- Messaging Service (`POST /messages/send`)
- Lead Service (`GET /leads?phone=`, `GET /leads/:id`)
- AI Service (`POST /ai/complete`)
- Audience Engine (`POST /audiences/evaluate`)
- Notification Service (`POST /notifications/publish`)

---

## 11. Testing Strategy

### Unit Tests (Vitest)

Pure functions and isolated logic:

- **conversation-resolver.ts:** find existing conversation within inactivity window; create new when expired; create new when none exists; correct `(lead_id, practice_number)` key matching
- **agent-mode.ts:** escalation threshold check (exchange count); confidence threshold (below 0.7 → escalate); human takeover clears `agent_mode_active`; disclosure footer appended correctly
- **outbound-sender.ts:** agent mode disabled on manual send; dedup_key generated per send

### Integration Tests (Vitest + real Postgres + real Redis)

External services mocked via HTTP interceptors:

- **Inbound happy path** — `inbound_message.received` → lead resolved → conversation found → message stored → `message.received` published → notification sent
- **Inbound new conversation** — inactivity expired → new conversation created, old conversation untouched
- **Inbound unknown phone** — lead not found → no conversation created, no event published, warn logged
- **Inbound agent mode** — agent enabled, unassigned → BullMQ job enqueued; coordinator assigned → no job enqueued
- **Inbound escalation** — `agent_exchange_count >= agent_max_exchanges` → escalated = true, no job enqueued, escalation notification sent
- **Outbound send** — coordinator POST → Messaging Service called → message inserted with `status: queued`
- **Outbound disables agent** — `agent_mode_active = true` → send → `agent_mode_active = false`
- **Delivery update** — `message.delivered` event → `conversation_messages.status` updated to `delivered`
- **AI agent reply** — BullMQ job → AI Service called → Messaging Service called → message inserted `is_agent: true`, `agent_exchange_count` incremented
- **AI agent escalation** — confidence < 0.7 → Messaging Service NOT called → `escalated = true`
- **Scheduled send** — create → BullMQ delayed job → fires at scheduled_for → Messaging Service called → status `sent`
- **Scheduled send cancel** — cancel before fire → status `cancelled` → worker skips (idempotency guard)
- **Read tracking** — POST /read → upserts `conversation_reads`; unread_count = 0 after read

### Contract Tests

- `message.received` event payload matches `@ortho/event-bus` schema
- Messaging Service call shape: `to`, `from_number`, `body`, `dedup_key` all present
- AI Service call shape: `prompt_id`, `context` present and correctly structured

---

## 12. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Message storage | Conversation Service owns its own copy | Self-contained inbox reads; can store CS-specific fields (conversation_id, read state, is_agent); aligns with SOA service autonomy principle |
| Conversation keying | `(lead_id, practice_number)` + time-based inactivity reset | Matches real-world SMS threading — same two numbers have one thread, but old inactive threads start fresh. Inactivity window configurable per location |
| Inbound lead resolution | Sync call to Lead Service `GET /leads?phone=` | Simple, always fresh. Hot-path latency acceptable (Lead Service has phone index); avoids maintaining a derived phone→lead cache |
| Agent mode scope | Location-level on/off | Simpler than per-sequence-step activation; matches marketing manager mental model of "turn AI on for this location"; individual conversations can still override via `PATCH /:id` |
| Agent mode processing | BullMQ job (async) | Avoids blocking the SQS event handler; provides retry semantics; allows timeout-safe AI Service calls |
| Scheduled send | BullMQ delayed job in Conversation Service | Keeps the concern local; no Nurturing Engine dependency for a simple one-shot timer |
| Bulk SMS | BullMQ batch job in Conversation Service | Campaign Service is email-only; bulk SMS is a coordinator inbox feature per PRD §5.1; Audience Engine resolves the segment |
| Human takeover | Manual send immediately disables agent mode | PRD §5.3 explicit requirement; coordinator action always wins over agent state |
| Notification delivery | Direct `POST /notifications/publish` call | Notification Service spec decision: product services call it directly, no EventBridge for notifications |
