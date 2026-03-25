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
Coordinator ──────► │  REST API                                        │
 (browser)          │    ├── conversations  (inbox list, thread)       │
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

## 3. Conversation Model

### 3.1 Identity and Threading

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

### 3.2 Multi-Conversation Per Lead

Each lead can have multiple conversations:
- Different practice numbers (different Twilio tracking numbers)
- Same practice number but separated by inactivity (time-based new thread)

All conversations for a lead are accessible via `GET /conversations?lead_id=uuid`.

---

## 4. API

**Route registration order note:** `/bulk-sends` and `/bulk-sends/:job_id` routes must be registered before `/:id` parameter routes to prevent Fastify from matching the literal string `bulk-sends` as a conversation ID.

### 4.1 Inbox

```
GET /conversations
    ?location_id=uuid&lead_id=uuid&status=open&assigned_to=me&page=1&limit=25
```
Returns conversation list. Access-scoped by JWT:
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
- `assigned_to` — any coordinator role; once set, AI agent stops handling new inbound messages for this conversation
- `agent_mode_active: false` — any coordinator role (disable agent for this conversation)
- `agent_mode_active: true` — `marketing_manager` role only (re-enable agent on a conversation)
- `status: 'closed'` — closes conversation
- `status: 'open'` — re-opens a closed conversation (any coordinator role)

**Conversation status and inbound routing:** `status = 'closed'` is a UI-layer signal only — it does not block inbound message append. If a lead replies to a closed conversation within the `inactivity_days` window, the message is appended and the conversation is automatically set back to `status = 'open'`. If the inactivity window has expired, a new conversation is created regardless of the closed conversation's status.

```
POST /conversations/:id/read
```
Upserts `conversation_reads` for calling user, setting `last_read_message_id` to the most recent message in the conversation at the time of the call.

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
Cancels a pending scheduled send: updates `status = 'cancelled'` in DB and removes the BullMQ job via `job.remove()`. Returns `409` if already sent.

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

All AI features call `POST /ai/complete` on the AI Service. Prompt IDs below must be registered in the AI Service prompt registry.

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

### 4.5 Bulk SMS

```
POST /bulk-sends
     { segment: { ...audience filter fields... }, body, location_id }
```
Enqueues a BullMQ bulk-send job. Returns `202 { job_id }`.

Access:
- `call_center_manager` — own location only
- `marketing_manager` — all locations

```
GET /bulk-sends/:job_id
    → { status, total, sent, failed }
```

### 4.6 Location Settings

```
GET   /settings/locations/:id
PATCH /settings/locations/:id
      { inactivity_days?, agent_mode_enabled?, agent_max_exchanges?, location_phone? }
```
`marketing_manager` role only.

**Validation:** `PATCH` with `agent_mode_enabled: true` returns `422` if `location_phone` is not already set and not provided in the same request — the disclosure footer cannot be rendered without it.

---

## 5. Key Flows

### 5.1 Inbound Message Flow

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
      { entity_type: 'lead', entity_id: lead.id,
        message_id, conversation_id, lead_id: lead.id, location_id: lead.location_id,
        body, message_type, from_number, practice_number: to_number, received_at }
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
        enqueue BullMQ job 'ai-agent-reply' { conversation_id, trigger_message_id }
```

**Note:** `message.delivered` / `message.failed` events are published by Messaging Service for all outbound messages system-wide. The delivery status handler updates `conversation_messages` by `messaging_message_id`. When no matching row is found (i.e., the message was sent by another service — Automation Engine, Nurturing Engine, etc.), the handler silently no-ops — this is expected behavior.

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
  (no rows matched = message owned by another service — silent no-op)

EventBridge: message.failed
  → UPDATE conversation_messages SET status = 'failed'
      WHERE messaging_message_id = event.message_id
  (no rows matched = silent no-op)
```

### 5.4 AI Agent Reply Flow

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
BullMQ job: ai-agent-reply { conversation_id, trigger_message_id }
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
        body: text + '\n\n' + disclosure_footer(settings.location_phone) }
  → INSERT conversation_messages (is_agent: true, status: 'queued')
  → UPDATE conversations SET agent_exchange_count += 1, last_message_at = now()
```

Disclosure footer template: `"This message was sent automatically. Reply STOP to opt out or call us at {location_phone} to speak with our team."`

`location_phone` is stored in `location_conversation_settings.location_phone`.

### 5.5 Scheduled Send Flow

```
POST /conversations/:id/scheduled-messages { body, scheduled_for }
  → INSERT scheduled_messages (status: 'pending')
  → enqueue BullMQ delayed job 'scheduled-send',
      delay = scheduled_for - now()
      job data: { scheduled_message_id }

DELETE /conversations/:id/scheduled-messages/:msg_id
  → UPDATE scheduled_messages SET status = 'cancelled' (if status = 'pending')
  → call job.remove() on the BullMQ job
      if job already executing → worker's idempotency guard (status != 'pending') skips send
  → 409 if status was already 'sent'

BullMQ job: scheduled-send { scheduled_message_id }
  → load scheduled_message — verify status = 'pending' (idempotency guard; 'cancelled' → skip)
  → POST /messages/send on Messaging Service
  → INSERT conversation_messages
  → UPDATE scheduled_messages SET status = 'sent', sent_at = now()
```

### 5.6 Bulk SMS Flow

The Audience Engine uses a hybrid push model — callers must provide entity data; the engine never fetches it independently.

**Cross-spec dependency:** This flow requires `GET /leads?location_id={id}&status=active` with cursor-based pagination on the Lead Service. This endpoint is not yet in the Lead Service spec and must be added. Required response fields per lead: `id`, `location_id`, `phone`, plus any filterable fields the Audience Engine segment may reference (e.g., `current_stage`, `current_pipeline`, `created_at`, `tags`).

```
BullMQ job: bulk-send { job_id, segment, body, location_id }
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
  → for each matched lead_id (batched):
      → phone = leadMap.get(lead_id).phone   ← reuse from paginate step, no re-fetch
      → POST /messages/send on Messaging Service
          { to: phone, from_number: conversation.practice_number, body,
            dedup_key: job_id + ':' + lead_id }
      → increment sent or failed counter
  → UPDATE bulk_send_jobs SET status = 'completed', sent = N, failed = M
```

---

## 6. AI Agent Mode

### 6.1 Configuration

Agent mode is a **location-level setting** (`location_conversation_settings.agent_mode_enabled`). When enabled, all new inbound messages on unassigned, non-escalated conversations at that location are handled autonomously by the AI until a human takes over or escalation triggers.

Configurable per location:
- `agent_mode_enabled` — on/off (default: false)
- `agent_max_exchanges` — max autonomous back-and-forth before forced escalation (default: 3)
- `location_phone` — practice phone number used in disclosure footer

### 6.2 Escalation Conditions

Any of the following triggers escalation (human takeover):

| Condition | Mechanism |
|---|---|
| `agent_exchange_count >= agent_max_exchanges` | Checked in inbound handler before enqueueing job |
| AI returns `escalate: true` in structured response | Checked in BullMQ worker after AI Service call |
| `response.text` fails JSON parse | BullMQ worker fail-safe — treats parse failure as escalation |
| `message_type = 'stop'` or `'unstop'` | Inbound handler skips AI entirely for opt-out commands |

On escalation: `conversations.escalated = true`, `agent_mode_active = false`, escalation notification pushed to location channel.

### 6.3 Human Takeover

- **Manual send** (`POST /conversations/:id/messages`): sets `agent_mode_active = false` immediately. Subsequent inbound messages are not AI-handled.
- **Coordinator assignment** (`PATCH /conversations/:id { assigned_to }`): once `assigned_to IS NOT NULL`, the inbound handler does not enqueue AI agent jobs regardless of `agent_mode_enabled`. Coordinator has ownership.
- **Re-enable**: `marketing_manager` can set `agent_mode_active: true` via `PATCH /conversations/:id` to hand back to the AI agent for a specific conversation (e.g., after resolving an escalation).
- Any coordinator can set `agent_mode_active: false` (disable) via `PATCH /conversations/:id`.

### 6.4 AI Service Prompt Requirements

The following prompts must be registered in the AI Service prompt registry (`src/prompts/`):

| prompt_id | Purpose | Expected `response.text` format |
|---|---|---|
| `conversation-reply-drafts` | Smart reply options | JSON array: `[{ "body": "...", "label": "..." }]` |
| `conversation-summary` | 3-sentence thread summary | Plain text |
| `conversation-objection-handling` | Strategy options for objections | JSON array: `[{ "title": "...", "body": "..." }]` |
| `conversation-agent-reply` | Autonomous agent response | JSON object: `{ "text": "...", "escalate": boolean, "reason"?: string }` |

---

## 7. Read Receipts

Two distinct mechanisms:

| Type | Source | Storage |
|---|---|---|
| Twilio delivery status | `message.delivered` EventBridge event | `conversation_messages.status`, `delivered_at` |
| Coordinator "seen" (in-app) | `POST /conversations/:id/read` | `conversation_reads (conversation_id, user_id, last_read_message_id)` |

**Unread count** (cursor-based): count of `conversation_messages` where `created_at >` the `created_at` of `last_read_message_id`. If no `conversation_reads` row exists for the user, all messages in the conversation are unread. Cursor-based comparison avoids clock-skew issues between the API server and database.

---

## 8. EventBridge Events

### Published

| Event | Trigger | Key Payload Fields |
|---|---|---|
| `message.received` | Inbound message processed and stored | `entity_type: "lead"`, `entity_id` (= lead_id), `message_id`, `conversation_id`, `lead_id`, `location_id`, `body`, `message_type`, `from_number`, `practice_number`, `received_at` |

The `entity_type` / `entity_id` fields follow the Automation Engine's generic event contract, enabling rule authors to reference `entity_id` as the lead ID in automation conditions.

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
  location_phone       text,                     -- E.164; required before agent_mode_enabled=true (enforced at API layer)
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (agent_mode_enabled = false OR location_phone IS NOT NULL)
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

## 10. Service Layout

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
- Lead Service (`GET /leads?phone=`, `GET /leads/:id`, `GET /leads?location_id=`)
- AI Service (`POST /ai/complete`)
- Audience Engine (`POST /audiences/evaluate`)
- Notification Service (`POST /notifications/publish`)

---

## 11. Testing Strategy

### Unit Tests (Vitest)

Pure functions and isolated logic:

- **conversation-resolver.ts:** find existing conversation within inactivity window; create new when expired; create new when none exists; correct `(lead_id, practice_number)` key matching
- **agent-mode.ts:** escalation threshold check (exchange count); JSON parse failure → escalate; `escalate: true` in parsed response → escalate; valid non-escalating response → send; `message_type = 'stop'` → skip AI; human takeover clears `agent_mode_active`; disclosure footer appended correctly with `location_phone`
- **outbound-sender.ts:** agent mode disabled on manual send; dedup_key generated per send

### Integration Tests (Vitest + real Postgres + real Redis)

External services mocked via HTTP interceptors:

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
- **AI agent reply** — BullMQ job → AI Service called → JSON parsed → Messaging Service called → message inserted `is_agent: true`, `agent_exchange_count` incremented
- **AI agent escalation (escalate: true)** — AI returns `{ escalate: true }` → Messaging Service NOT called → `escalated = true`
- **AI agent escalation (parse failure)** — AI returns non-JSON → treated as escalation → `escalated = true`
- **Scheduled send** — create → BullMQ delayed job → fires at `scheduled_for` → Messaging Service called → status `sent`
- **Scheduled send cancel** — cancel before fire → status `cancelled`, job removed → worker skips (idempotency guard)
- **Read tracking** — POST /read → upserts `conversation_reads` with `last_read_message_id`; unread_count = 0 after read
- **PATCH agent_mode_active: true** — requires `marketing_manager` role; coordinator role → 403

### Contract Tests

- `message.received` event payload matches `@ortho/event-bus` schema; includes `entity_type: "lead"` and `entity_id`
- Messaging Service call shape: `to`, `from_number`, `body`, `dedup_key` all present
- AI Service call shape for `conversation-agent-reply`: `prompt_id`, `context` present; `response.text` parseable as `{ text, escalate }` JSON

---

## 12. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Message storage | Conversation Service owns its own copy | Self-contained inbox reads; can store CS-specific fields (conversation_id, read state, is_agent); aligns with SOA service autonomy principle |
| Conversation keying | `(lead_id, practice_number)` + time-based inactivity reset | Matches real-world SMS threading — same two numbers have one thread, but old inactive threads start fresh. Inactivity window configurable per location |
| Inbound lead resolution | Sync call to Lead Service `GET /leads?phone=` | Simple, always fresh. Hot-path latency acceptable (Lead Service has phone index); avoids maintaining a derived phone→lead cache |
| Agent mode scope | Location-level on/off | Simpler than per-sequence-step activation; matches marketing manager mental model of "turn AI on for this location" |
| Agent mode escalation | Structured JSON response from AI Service prompt | AI Service returns `{ text, model, prompt_id, cached }` only — no confidence field. Prompt instructs Claude to return `{ text, escalate }` JSON; parse failure treated as escalation (fail-safe) |
| Agent mode processing | BullMQ job (async) | Avoids blocking the SQS event handler; provides retry semantics; allows timeout-safe AI Service calls |
| Scheduled send cancellation | DB update + BullMQ `job.remove()` | Belt-and-suspenders: removes job from queue when possible; worker's idempotency guard handles the race if job fires simultaneously |
| Bulk SMS entity flow | Fetch leads from Lead Service → push to Audience Engine | Audience Engine is a hybrid push model — callers always provide entity data; engine never fetches it |
| Bulk SMS routing | Separate `/bulk-sends` prefix | Avoids Fastify route ambiguity with `/:id` parameter routes |
| STOP/UNSTOP handling | Skip AI agent, store in thread | Opt-out commands should be visible in conversation history but must never trigger AI agent processing |
| Human takeover | Manual send OR coordinator assignment disables agent mode | PRD §5.3 explicit requirement; both coordinator assignment and manual send represent human ownership |
| Notification delivery | Direct `POST /notifications/publish` call | Notification Service spec decision: product services call it directly, no EventBridge for notifications |
| `message.received` event shape | Includes `entity_type: "lead"`, `entity_id` | Automation Engine consumes generic `{ entity_type, entity_id, event_type, payload }` — these fields map to the correct Automation Engine contract |
| Conversation re-open on inbound | Automatic when inactivity window not expired | A `closed` conversation is a UI signal only; inbound replies reopen it automatically within the window. After the window, a new conversation is created. |

**Pending amendments required:**
- **Lead Service spec** must add: `GET /leads?location_id={id}&status=active` with cursor-based pagination, returning at minimum `{ id, location_id, phone, current_stage, current_pipeline, created_at, tags }` — required by the bulk SMS worker.
