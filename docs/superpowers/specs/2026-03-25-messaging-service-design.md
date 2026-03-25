# Messaging Service — Design Spec

**Date:** 2026-03-25
**Status:** Draft
**Scope:** Platform-layer Messaging Service — outbound SMS/MMS via Twilio, inbound webhook handling, delivery status tracking, phone number pool management, opt-out registry, inline template rendering, Redis rate limiting

---

## 1. Overview

The Messaging Service (`apps/platform/messaging`) is a **platform-layer SMS/MMS gateway** over Twilio. It is fully domain-agnostic — it has no concept of leads, pipelines, or coordinators.

**Core responsibilities:**
- Send outbound SMS/MMS via Twilio API
- Receive inbound SMS via Twilio webhooks and publish to EventBridge
- Track delivery status via Twilio status callbacks; emit `message.delivered` / `message.failed`
- Manage phone number pool (static provisioning + resolution by `location_id`+`channel` or direct `from_number`)
- Render SMS templates inline (merge tag resolution) or accept a pre-rendered `body`
- Enforce opt-out registry: reject sends to opted-out numbers; detect STOP/UNSTOP replies; emit `opt_out.received`
- Rate-limit outbound sends per Twilio number via Redis token bucket (10DLC compliance)
- Idempotency via caller-supplied `dedup_key` — duplicate sends silently no-op

**Out of scope:**
- Voice/call tracking
- Email delivery (Email Service)
- Template storage and versioning (SMS templates are plain strings with `{{merge_tag}}` syntax, stored by callers or inline in automation rules)
- Scheduling and delays (Nurturing Engine, Automation Engine)

---

## 2. Architecture

```
Automation Engine / Nurturing Engine / Conversation Service
        │
        ▼  POST /messages/send
┌──────────────────────────────────────────────────────┐
│              Messaging Service                        │
│   apps/platform/messaging                            │
│                                                      │
│  REST API                                            │
│    ├── send-message        (opt-out → dedup →        │
│    │                        number resolve →          │
│    │                        render → rate limit →     │
│    │                        Twilio API → DB insert)   │
│    ├── number-resolver     (location_id+channel OR   │
│    │                        explicit from_number)     │
│    ├── template-renderer   (inline {{merge_tag}})    │
│    ├── opt-out-registry    (check / register / remove)│
│    └── rate-limiter        (Redis token bucket)       │
│                                                      │
│  Twilio Webhooks                                     │
│    ├── /webhooks/twilio/inbound  (inbound SMS)       │
│    └── /webhooks/twilio/status   (delivery callbacks)│
└──────────────────────────────────────────────────────┘
        │
        ▼  EventBridge
  inbound_message.received → Conversation Service
  message.delivered        → Conversation Service, Analytics
  message.failed           → Automation Engine
  opt_out.received         → Lead Service, Nurturing Engine
```

---

## 3. API

### 3.1 Outbound Messages

**Send a message**

```
POST /messages/send
```

Request body (one of `from_number` or `location_id`+`channel`; one of `template`+`context` or `body`):

```json
{
  "to": "+15551234567",
  "from_number": "+15559876543",
  "location_id": "uuid",
  "channel": "google",
  "template": "Hi {{first_name}}, your free exam at {{location_name}} is ready to book.",
  "context": { "first_name": "Sara", "location_name": "North Austin" },
  "body": "Hi Sara, ...",
  "media_url": "https://example.com/image.jpg",
  "dedup_key": "evt-abc-sms-1"
}
```

Callers (Automation Engine, Nurturing Engine) embed the template string directly in their rule or sequence definitions. The Messaging Service does not store or look up templates by ID.

Responses:
- `200` — `{ "message_id": "uuid", "status": "queued" }` — accepted and sent to Twilio
- `400` — destination number is opted out
- `409` — `dedup_key` already exists (silent no-op; treated as success by callers)
- `422` — validation error (missing required fields, invalid E.164, etc.)
- `429` — rate limit exceeded; includes `Retry-After` header (seconds)

**Fetch a message**

```
GET /messages/:id
```

Returns the full message record including current delivery status.

**List messages**

```
GET /messages?to=+15551234567&from_number=+15559876543&status=delivered&from_date=2026-03-01&to_date=2026-03-31
```

### 3.2 Phone Number Pool

```
POST   /numbers              — provision a number
DELETE /numbers/:id          — deprovision
GET    /numbers              — list (filter by location_id, channel, active)
GET    /numbers/resolve?location_id=uuid&channel=google  — resolve to phone_number
```

Provision request body:
```json
{
  "location_id": "uuid",
  "channel": "google",
  "phone_number": "+15552223333",
  "friendly_name": "North Austin — Google"
}
```

### 3.3 Opt-out Registry

```
GET    /opt-outs/:phone      — returns { opted_out: true|false, opted_out_at? }
POST   /opt-outs             — manually register opt-out (admin)
DELETE /opt-outs/:phone      — manually remove opt-out (admin UNSTOP)
```

### 3.4 Twilio Webhooks (Twilio → Messaging Service)

```
POST /webhooks/twilio/inbound    — inbound SMS
POST /webhooks/twilio/status     — delivery status callback
```

Both endpoints validate the `X-Twilio-Signature` header before processing. Invalid signatures return `403` with no side effects.

---

## 4. Outbound Send Flow

```
POST /messages/send
  → validate request shape
  → check opt-out registry (messaging_opt_outs)
      opted out → return 400
  → check dedup_key in messaging_messages
      exists → return 409
  → resolve from_number:
      if from_number provided → use directly
      if location_id + channel → query messaging_numbers
      number not found or inactive → return 422
  → render body:
      if template + context → inline {{merge_tag}} substitution
      if body → use as-is
  → check rate limiter (Redis token bucket keyed by from_number)
      throttled → return 429 with Retry-After header
  → call Twilio messages.create (to, from, body, mediaUrl, statusCallback)
  → INSERT messaging_messages (status: 'queued', twilio_sid populated)
  → return 200 { message_id, status: 'queued' }
```

---

## 5. Inbound SMS Flow

```
POST /webhooks/twilio/inbound
  → validate X-Twilio-Signature → 403 if invalid
  → parse Twilio params (From, To, Body, MediaUrl0..N)
  → INSERT messaging_messages (direction: 'inbound', status: 'received')
  → check if body matches STOP variants
      (STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT — case-insensitive, trim whitespace)
      → INSERT messaging_opt_outs (source: 'stop_reply')
      → publish opt_out.received to EventBridge
  → check if body matches UNSTOP/START variants
      → DELETE from messaging_opt_outs
      → publish opt_out.removed to EventBridge
  → publish inbound_message.received to EventBridge
  → return 200 with empty TwiML response (no auto-reply)
```

Message insert occurs before opt-out processing so every inbound SMS is recorded regardless of subsequent failures. The `inbound_message.received` event is published for all inbound messages, including STOP/UNSTOP — Conversation Service records the exchange in the thread.

---

## 6. Delivery Status Callback Flow

```
POST /webhooks/twilio/status
  → validate X-Twilio-Signature → 403 if invalid
  → parse MessageSid, MessageStatus, ErrorCode, ErrorMessage
  → lookup messaging_messages by twilio_sid
  → UPDATE status:
      'queued' / 'sending' / 'sent' → update status field, no event emitted
      'delivered' → update status, set delivered_at
      'failed' / 'undelivered' → update status, set error_code, error_message
  → publish to EventBridge:
      delivered → message.delivered
      failed    → message.failed
      (intermediate statuses update DB only — no EventBridge event)
```

---

## 7. Rate Limiting

Per-number Redis token bucket for 10DLC compliance:

- **Key:** `rate_limit:msg:{from_number}`
- **Capacity:** configurable per number (default: 3 tokens for 10DLC registered numbers; 1 token for unregistered long codes)
- **Refill rate:** matches capacity per second (e.g. 3 tokens/second for registered 10DLC)
- **Implementation:** Lua script (atomic check-and-consume) to avoid race conditions across service instances
- **On throttle:** return `429` with `Retry-After: 1` — callers (Automation Engine, Nurturing Engine) already have BullMQ retry semantics and will retry automatically
- **Configuration:** stored on the `messaging_numbers` row as `rate_limit_mps integer NOT NULL DEFAULT 3`

No BullMQ in the Messaging Service — sends are synchronous. Rate limit enforcement is Redis-only.

---

## 8. Template Rendering

Inline `{{merge_tag}}` substitution — no Template Service dependency.

- Scans the template string for `{{key}}` patterns
- Resolves each key against the flat `context` object
- Missing keys render as empty string (no error thrown)
- Pre-rendered `body` strings bypass rendering entirely

SMS templates are short strings (160 chars for single SMS, up to 1600 for concatenated). This complexity does not justify an external rendering service call on every send.

---

## 9. EventBridge Events

**Published by Messaging Service:**

| Event | Trigger | Key Payload Fields |
|---|---|---|
| `inbound_message.received` | Inbound SMS webhook | `message_id`, `from_number`, `to_number`, `body`, `media_urls`, `received_at` |
| `message.delivered` | Twilio status callback — delivered | `message_id`, `twilio_sid`, `to_number`, `from_number`, `delivered_at` |
| `message.failed` | Twilio status callback — failed | `message_id`, `twilio_sid`, `to_number`, `from_number`, `error_code`, `error_message` |
| `opt_out.received` | STOP reply detected | `phone_number`, `opted_out_at`, `source: 'stop_reply'` |
| `opt_out.removed` | UNSTOP/START reply detected | `phone_number`, `removed_at` |

**Subscribed by Messaging Service:** None.

**Downstream subscribers:**

| Event | Subscribers |
|---|---|
| `inbound_message.received` | Conversation Service |
| `message.delivered` | Conversation Service, Analytics |
| `message.failed` | Automation Engine |
| `opt_out.received` | Lead Service, Nurturing Engine |
| `opt_out.removed` | Lead Service, Nurturing Engine |

---

## 10. Database Schema — `platform_messaging`

```sql
-- Phone number pool: maps location+channel to a Twilio number
messaging_numbers (
  id               uuid PRIMARY KEY,
  location_id      uuid NOT NULL,
  channel          text NOT NULL,             -- 'google', 'facebook', 'sms_inbox', 'referral', etc.
  phone_number     text NOT NULL UNIQUE,      -- E.164 format
  friendly_name    text,
  active           boolean NOT NULL DEFAULT true,
  rate_limit_mps   integer NOT NULL DEFAULT 3, -- messages per second cap (1 for unregistered, 3+ for 10DLC)
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, channel)
)

-- Outbound + inbound message log
messaging_messages (
  id            uuid PRIMARY KEY,
  direction     text NOT NULL,          -- 'outbound' | 'inbound'
  to_number     text NOT NULL,          -- E.164
  from_number   text NOT NULL,          -- E.164
  body          text,
  media_urls    text[],                 -- MMS attachments
  status        text NOT NULL,          -- 'queued'|'sent'|'delivered'|'failed'|'received'
  twilio_sid    text UNIQUE,            -- Twilio message SID (populated after API call)
  dedup_key     text UNIQUE,            -- caller-supplied; NULL for inbound
  error_code    text,                   -- Twilio error code on failure
  error_message text,
  sent_at       timestamptz,
  delivered_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
)

-- Opt-out registry
messaging_opt_outs (
  phone_number  text PRIMARY KEY,       -- E.164
  opted_out_at  timestamptz NOT NULL DEFAULT now(),
  source        text NOT NULL           -- 'stop_reply' | 'manual' | 'admin'
)
```

**Indexes:**
- `messaging_messages(to_number, created_at DESC)` — inbox queries
- `messaging_messages(from_number, created_at DESC)` — per-number send history
- `messaging_messages(dedup_key)` — enforced by UNIQUE constraint
- `messaging_messages(twilio_sid)` — status callback lookup

---

## 11. Service Layout

```
apps/platform/messaging/
├── src/
│   ├── routes/
│   │   ├── messages.ts          # POST /messages/send, GET /messages, GET /messages/:id
│   │   ├── numbers.ts           # CRUD /numbers, GET /numbers/resolve
│   │   ├── opt-outs.ts          # GET/POST/DELETE /opt-outs/:phone
│   │   └── webhooks.ts          # POST /webhooks/twilio/inbound, /status
│   ├── services/
│   │   ├── send-message.ts      # outbound flow orchestrator
│   │   ├── template-renderer.ts # inline {{merge_tag}} resolution (pure function)
│   │   ├── number-resolver.ts   # from_number vs location_id+channel lookup
│   │   ├── opt-out-registry.ts  # check, register, remove opt-outs
│   │   ├── rate-limiter.ts      # Redis token bucket per number (Lua script)
│   │   ├── twilio-client.ts     # Twilio SDK wrapper
│   │   └── twilio-webhook.ts    # X-Twilio-Signature validation (pure function)
│   ├── repositories/
│   │   ├── messages.repo.ts
│   │   ├── numbers.repo.ts
│   │   └── opt-outs.repo.ts
│   ├── events/
│   │   └── publisher.ts         # EventBridge publish helpers
│   └── index.ts
├── migrations/
├── test/
├── Dockerfile
├── package.json
└── tsconfig.json
```

**Runtime dependencies:**
- PostgreSQL (`platform_messaging` schema)
- Redis (rate limiter token buckets)
- AWS EventBridge (event publishing)
- Twilio SDK (`twilio` npm package)

---

## 12. Testing Strategy

### Unit Tests (Vitest)

Pure functions — no external dependencies:

- **Template renderer:** merge tag substitution, missing keys render as empty string, nested context objects, pre-rendered body passthrough, edge cases (empty template, no tags)
- **Number resolver:** explicit `from_number` passthrough, `location_id`+`channel` lookup hit and miss, inactive number returns error
- **Rate limiter:** token available → pass, token exhausted → throttle with correct `Retry-After`, token refills after interval, concurrent requests (Lua atomicity)
- **Twilio webhook validator:** valid signature → pass, tampered payload → reject, missing header → reject
- **STOP detection:** `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT` variants; `UNSTOP`/`START` reversal; case-insensitive; leading/trailing whitespace

### Integration Tests (Vitest + real Postgres + real Redis)

Twilio SDK mocked via HTTP interceptor:

- Outbound happy path — opt-out check, dedup check, number resolve, render, rate limit, Twilio call, DB insert, 200 response
- Dedup — same `dedup_key` twice → second call returns 409, Twilio called exactly once
- Opted-out number → 400, Twilio never called
- Rate limit exceeded → 429 with `Retry-After`, Twilio never called
- Number resolve — `location_id`+`channel` resolves correctly; unknown combination → 422
- Status callback delivered → DB status updated, `message.delivered` published
- Status callback failed → DB status + error fields updated, `message.failed` published
- Invalid Twilio signature on webhook → 403, no DB writes, no events published
- Inbound STOP → message inserted first, opt-out inserted, `opt_out.received` published, `inbound_message.received` published
- Inbound UNSTOP → message inserted first, opt-out removed, `opt_out.removed` published, `inbound_message.received` published
- Inbound normal message → message inserted, `inbound_message.received` published
- Status callback intermediate (`sent`) → DB status updated, no EventBridge event

### Contract Tests

**Outbound calls — verify Twilio SDK call shape:**
- `messages.create` payload: `to`, `from`, `body`, `mediaUrl`, `statusCallback` URL present and correctly formatted

**Events published — verify against `@ortho/event-bus` schema:**
- `inbound_message.received`, `message.delivered`, `message.failed`, `opt_out.received`, `opt_out.removed` all match declared schema

---

## 13. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Rate limiting mechanism | Redis token bucket (no BullMQ) | Callers already own retry/delay logic (Automation Engine, Nurturing Engine). Adding BullMQ creates double-retry complexity and makes `POST /messages/send` async, complicating dedup. Redis token bucket is sufficient for 10DLC compliance at expected volumes. |
| Template rendering | Inline in Messaging Service | SMS templates are short strings with simple `{{merge_tag}}` substitution. Delegating to Template Service adds a synchronous dependency on every send for no benefit at this complexity level. |
| Inbound routing | EventBridge `inbound_message.received` | Platform service must not call product-layer services directly. This service emits `inbound_message.received`; Conversation Service (product layer) subscribes, enriches with lead/conversation context, and emits its own downstream `message.received` event. |
| Opt-out enforcement | Checked on every `POST /messages/send` | Callers do not manage opt-out state. Single enforcement point in the Messaging Service prevents leakage across Automation Engine, Nurturing Engine, and Conversation Service. |
| Dedup | Unique `dedup_key` constraint in DB | Handles at-least-once delivery from BullMQ callers safely. 409 is a silent no-op — callers treat it as success. |
| Status callbacks | Twilio push → DB update → EventBridge | Polling Twilio for delivery status would be wasteful. Twilio pushes callbacks to the service; the service updates the record and emits events downstream. |
| Voice | Out of scope | Call tracking is a separate concern; excluding it keeps the service focused on SMS/MMS. |
