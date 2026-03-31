# Messaging Service — Updated Design Spec

**Date:** 2026-03-30
**Status:** Approved
**Scope:** Platform-layer Messaging Service — outbound SMS/MMS via Twilio, inbound webhook handling, delivery status tracking, phone number pool management, opt-out registry, inline template rendering, Redis rate limiting
**Supersedes:** `2026-03-25-messaging-service-design.md` (original spec + clarifications from `tasks/prd-questions-messaging-service.md`)

---

## 1. Overview

The Messaging Service (`apps/platform/messaging`) is a **platform-layer SMS/MMS gateway** over Twilio. It is fully domain-agnostic — it has no concept of leads, pipelines, or coordinators.

**Core responsibilities:**
- Send outbound SMS/MMS via Twilio API
- Receive inbound SMS via Twilio webhooks and publish to EventBridge
- Track delivery status via Twilio status callbacks; emit `message.delivered` / `message.failed`
- Manage phone number pool (static provisioning + resolution by `location_id`+`channel` or direct `from_number`)
- Render SMS templates inline (merge tag resolution) or accept a pre-rendered `body`
- Enforce opt-out registry: reject sends to opted-out numbers; detect STOP/UNSTOP replies; emit `opt_out.received` / `opt_out.removed`
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
│                                                      │
│  Health                                              │
│    └── GET /health         (liveness check)          │
└──────────────────────────────────────────────────────┘
        │
        ▼  EventBridge (via @ortho/event-bus)
  inbound_message.received → Conversation Service, Lead Service
  message.delivered        → Conversation Service, Analytics, Lead Service
  message.failed           → Automation Engine, Lead Service
  opt_out.received         → Lead Service, Nurturing Engine
  opt_out.removed          → Lead Service, Nurturing Engine
```

---

## 3. Implementation Phases

The service is built in three phases:

### Phase 1 — Foundation: DB + Repositories + Number Pool
- Database schema and Knex migrations (local to service)
- Repository layer (`messages.repo.ts`, `numbers.repo.ts`, `opt-outs.repo.ts`)
- Phone number pool CRUD routes (`POST /numbers`, `DELETE /numbers/:id`, `GET /numbers`, `GET /numbers/resolve`)
- Seed script for development/testing number pool data
- Health check endpoint (`GET /health`)
- Fastify app bootstrap with `@ortho/logger` (Pino structured logging)

### Phase 2 — Outbound Send Flow
- `POST /messages/send` full pipeline: opt-out check → dedup check → number resolve → template render → rate limit → Twilio API call → DB insert
- Twilio client stub (lightweight in-process mock for dev/test)
- Redis token bucket rate limiter (separate `.lua` file, `SCRIPT LOAD` + `evalsha()`)
- Opt-out registry routes (`GET /opt-outs/:phone`, `POST /opt-outs`, `DELETE /opt-outs/:phone`)
- `GET /messages/:id` and `GET /messages` (cursor-based pagination)

### Phase 3 — Inbound/Status Webhooks + EventBridge Events
- Twilio inbound webhook (`POST /webhooks/twilio/inbound`) with HMAC-SHA1 signature validation
- Twilio status callback webhook (`POST /webhooks/twilio/status`) with HMAC-SHA1 signature validation
- STOP/UNSTOP detection and opt-out registry updates
- EventBridge event publishing via `@ortho/event-bus` package (typed helpers, see `docs/arch/adr-event-bus.md`)
- All five events: `inbound_message.received`, `message.delivered`, `message.failed`, `opt_out.received`, `opt_out.removed`

---

## 4. API

### 4.1 Outbound Messages

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

**No auth required** on `/messages/send` — this is an internal service-to-service endpoint.

Responses:
- `200` — `{ "message_id": "uuid", "status": "queued" }` — accepted and sent to Twilio. Also returned for duplicate `dedup_key` — the existing `message_id` is returned so callers treat it as success without special handling.
- `400` — destination number is opted out
- `422` — validation error (missing required fields, invalid E.164, etc.)
- `429` — rate limit exceeded; includes `Retry-After` header (seconds)
- `502` — Twilio API error. Message record inserted with `status: 'failed'`. Response body includes Twilio error details so callers can distinguish Twilio failures from validation errors:
  ```json
  {
    "error": "twilio_error",
    "message_id": "uuid",
    "status": "failed",
    "twilio_error_code": "30008",
    "twilio_error_message": "Unknown error"
  }
  ```

**Fetch a message**

```
GET /messages/:id
```

Returns the full message record including current delivery status.

**List messages**

```
GET /messages?to=+15551234567&from_number=+15559876543&status=delivered&from_date=2026-03-01&to_date=2026-03-31&cursor=<opaque>&limit=50
```

Cursor-based pagination (keyset pagination using `created_at` + `id`). Returns:
```json
{
  "data": [...],
  "next_cursor": "eyJjcmVhdGVkX2F0IjoiMjAyNi0wMy0yOVQxMjowMDowMFoiLCJpZCI6InV1aWQifQ==",
  "has_more": true
}
```

### 4.2 Phone Number Pool

```
POST   /numbers              — provision a number (auth required)
DELETE /numbers/:id          — deprovision (auth required)
GET    /numbers              — list (filter by location_id, channel, active) (auth required)
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

### 4.3 Opt-out Registry

```
GET    /opt-outs/:phone      — returns { opted_out: true|false, opted_out_at? } (auth required)
POST   /opt-outs             — manually register opt-out (admin) (auth required)
DELETE /opt-outs/:phone      — manually remove opt-out (admin UNSTOP) (auth required)
```

### 4.4 Twilio Webhooks (Twilio → Messaging Service)

```
POST /webhooks/twilio/inbound    — inbound SMS
POST /webhooks/twilio/status     — delivery status callback
```

Both endpoints validate the `X-Twilio-Signature` header using a manual HMAC-SHA1 implementation (pure function — no dependency on the Twilio SDK in the webhook path). Invalid signatures return `403` with no side effects.

### 4.5 Health Check

```
GET /health
```

Returns `200 { "status": "ok" }`. Liveness probe for container orchestration.

### 4.6 Auth Strategy

- **Auth required** (via `@ortho/auth-middleware`): Admin/external-facing routes — `/numbers/*`, `/opt-outs/*`
- **No auth**: Internal service-to-service routes — `/messages/send`, `/messages/:id`, `/messages`
- **Twilio signature validation**: Webhook routes — `/webhooks/twilio/*`
- **Structured logging** via `@ortho/logger` on all routes

---

## 5. Outbound Send Flow

```
POST /messages/send
  → validate request shape (TypeBox schema)
  → check opt-out registry (messaging_opt_outs)
      opted out → return 400
  → check dedup_key in messaging_messages
      exists → return 200 with existing message_id (idempotent success)
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
      Twilio error → INSERT messaging_messages (status: 'failed', error_code, error_message)
                   → return 502 with Twilio error details
  → INSERT messaging_messages (status: 'queued', twilio_sid populated)
  → return 200 { message_id, status: 'queued' }
```

---

## 6. Inbound SMS Flow

```
POST /webhooks/twilio/inbound
  → validate X-Twilio-Signature (manual HMAC-SHA1) → 403 if invalid
  → parse Twilio params (From, To, Body, MediaUrl0..N)
  → INSERT messaging_messages (direction: 'inbound', status: 'received')
      DB insert fails → return 500 (Twilio retries per its retry policy)
  → check if body matches STOP variants
      (STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT — case-insensitive, trim whitespace)
      → INSERT messaging_opt_outs (source: 'stop_reply')
      → publish opt_out.received to EventBridge (via @ortho/event-bus)
  → check if body matches UNSTOP/START variants
      → number exists in messaging_opt_outs?
          YES → DELETE from messaging_opt_outs
                publish opt_out.removed to EventBridge
          NO  → no-op (no event published — avoids spurious events to subscribers)
  → publish inbound_message.received to EventBridge
  → return 200 with empty TwiML response (no auto-reply)
```

Message insert occurs before opt-out processing so every inbound SMS is recorded regardless of subsequent failures. The `inbound_message.received` event is published for all inbound messages, including STOP/UNSTOP — Conversation Service records the exchange in the thread. The event includes a `message_type` field (`'normal'` | `'stop'` | `'unstop'`) so Conversation Service can render opt-out keywords distinctly without re-parsing the body.

**Error handling:** If the DB insert fails after signature validation, the webhook returns `500` so Twilio retries the delivery. EventBridge publish failures after a successful DB insert are non-critical — they are logged but do not cause a `500` response.

---

## 7. Delivery Status Callback Flow

```
POST /webhooks/twilio/status
  → validate X-Twilio-Signature (manual HMAC-SHA1) → 403 if invalid
  → parse MessageSid, MessageStatus, ErrorCode, ErrorMessage
  → lookup messaging_messages by twilio_sid
  → UPDATE status:
      'queued' / 'sending' / 'sent' → update status field, no event emitted
      'delivered' → update status, set delivered_at
      'failed' / 'undelivered' → update status, set error_code, error_message
  → publish to EventBridge (via @ortho/event-bus):
      delivered → message.delivered
      failed    → message.failed
      (intermediate statuses update DB only — no EventBridge event)
```

---

## 8. Rate Limiting

Per-number Redis token bucket for 10DLC compliance:

- **Key:** `rate_limit:msg:{from_number}`
- **Capacity and refill rate:** both equal `rate_limit_mps` from the number record. A number with `rate_limit_mps = 3` has a bucket capacity of 3 tokens that refills at 3 tokens/second — sustaining up to 3 messages/second with no burst above that rate. Default `rate_limit_mps = 3` for 10DLC registered numbers; set to `1` for unregistered long codes.
- **Implementation:** Separate Lua script file (`src/services/rate-limiter.lua`), loaded at service startup via `SCRIPT LOAD`, executed via `redis.evalsha()` with cached SHA. Atomic check-and-consume to avoid race conditions across service instances.
- **On throttle:** return `429` with `Retry-After: 1` — callers (Automation Engine, Nurturing Engine) already have BullMQ retry semantics and will retry automatically
- **Configuration:** stored on the `messaging_numbers` row as `rate_limit_mps integer NOT NULL DEFAULT 3`

No BullMQ in the Messaging Service — sends are synchronous. Rate limit enforcement is Redis-only.

---

## 9. Template Rendering

Inline `{{merge_tag}}` substitution — no Template Service dependency.

- Scans the template string for `{{key}}` patterns
- Resolves each key against the flat `context` object
- Missing keys render as empty string (no error thrown)
- Pre-rendered `body` strings bypass rendering entirely

SMS templates are short strings (160 chars for single SMS, up to 1600 for concatenated). This complexity does not justify an external rendering service call on every send.

---

## 10. Twilio Client Integration

### Production
The service uses the Twilio SDK (`twilio` npm package) for outbound `messages.create` calls.

### Development & Testing
A **lightweight in-process mock/stub** of the Twilio client is used instead of real HTTP calls. The stub:
- Implements the same interface as the real Twilio client (`messages.create`)
- Records all calls (arguments and call count) for test assertions
- Returns canned successful responses by default
- Can be configured to simulate errors (invalid number, Twilio outage) for error-path testing
- No HTTP interceptors or real Twilio test credentials required

The Twilio client is injected via constructor/factory so tests can swap in the stub without patching modules.

---

## 11. Twilio Webhook Signature Validation

Webhook signature validation is implemented as a **manual HMAC-SHA1 pure function** — no dependency on the full Twilio SDK in the webhook path.

Implementation:
- Receives the `X-Twilio-Signature` header, request URL, and POST body parameters
- Constructs the data string per Twilio's spec: URL + sorted POST parameters concatenated as key/value pairs
- Computes HMAC-SHA1 using the Twilio auth token as the key
- Base64-encodes the result and compares against the header value
- Registered as a Fastify `preHandler` hook on webhook routes

This keeps the webhook path lightweight and testable without Twilio SDK overhead.

---

## 12. EventBridge Events

Events are published via the shared **`@ortho/event-bus`** package with typed event helpers (see `docs/arch/adr-event-bus.md` for driver details, configuration, and usage patterns). The event bus uses pluggable drivers: EventBridge for production, Redis Streams for local/integration testing, MockDriver for unit tests.

**Published by Messaging Service:**

| Event | Trigger | Key Payload Fields |
|---|---|---|
| `inbound_message.received` | Inbound SMS webhook | `message_id`, `from_number`, `to_number`, `body`, `media_urls`, `received_at`, `message_type` (`'normal'`\|`'stop'`\|`'unstop'`) |
| `message.delivered` | Twilio status callback — delivered | `message_id`, `twilio_sid`, `to_number`, `from_number`, `location_id`, `delivered_at` |
| `message.failed` | Twilio status callback — failed | `message_id`, `twilio_sid`, `to_number`, `from_number`, `location_id`, `error_code`, `error_message` |
| `opt_out.received` | STOP reply detected | `phone_number`, `opted_out_at`, `source: 'stop_reply'`, `location_id` (nullable) |
| `opt_out.removed` | UNSTOP/START reply detected | `phone_number`, `removed_at` |

**Subscribed by Messaging Service:** None.

**Downstream subscribers:**

| Event | Subscribers |
|---|---|
| `inbound_message.received` | Conversation Service, Lead Service |
| `message.delivered` | Conversation Service, Analytics, Lead Service |
| `message.failed` | Automation Engine, Lead Service |
| `opt_out.received` | Lead Service, Nurturing Engine |
| `opt_out.removed` | Lead Service, Nurturing Engine |

**`location_id` resolution:** For `message.delivered` and `message.failed` events, `location_id` is resolved by looking up `from_number` (the Twilio number that sent the message) in `messaging_numbers`. For `opt_out.received` events triggered by STOP replies, `location_id` is resolved from `to_number` (the practice's Twilio number that received the STOP). Manually registered opt-outs (`source: 'manual'` or `'admin'`) set `location_id: null` — no Twilio number context is available.

---

## 13. Database Schema — `platform_messaging`

Migrations are **local to the service** (`migrations/` directory) using Knex with a local Knex config file. No dependency on the shared `@ortho/db` package for migrations.

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
  message_type  text NOT NULL DEFAULT 'normal', -- 'normal' | 'stop' | 'unstop' (inbound only)
  status        text NOT NULL,          -- outbound: 'queued'|'sending'|'sent'|'delivered'|'failed'|'undelivered'; inbound: 'received'
  twilio_sid    text UNIQUE,            -- Twilio message SID (populated after API call)
  dedup_key     text UNIQUE,            -- caller-supplied; NULL for inbound
  error_code    text,                   -- Twilio error code on failure
  error_message text,
  sent_at       timestamptz,
  delivered_at  timestamptz,
  received_at   timestamptz,            -- populated for inbound messages (= created_at for inbound)
  created_at    timestamptz NOT NULL DEFAULT now()
)

-- Opt-out registry (hard delete on UNSTOP — no soft-delete/audit trail)
-- removed_at in opt_out.removed event is set to now() at deletion time
messaging_opt_outs (
  phone_number  text PRIMARY KEY,       -- E.164
  opted_out_at  timestamptz NOT NULL DEFAULT now(),
  source        text NOT NULL           -- 'stop_reply' | 'manual' | 'admin'
)
```

**Indexes:**
- `messaging_messages(to_number, created_at DESC)` — inbox queries
- `messaging_messages(from_number, created_at DESC)` — per-number send history
- `messaging_messages(status, created_at DESC)` — status filter on GET /messages
- `messaging_messages(dedup_key)` — enforced by UNIQUE constraint
- `messaging_messages(twilio_sid)` — status callback lookup

### Dev/Test Seed Script

A seed script (`seeds/dev-numbers.ts`) inserts test phone numbers into `messaging_numbers` for local development and testing. Run manually or as part of dev setup via `npm run seed`.

---

## 14. Service Layout

```
apps/platform/messaging/
├── src/
│   ├── routes/
│   │   ├── messages.ts          # POST /messages/send, GET /messages, GET /messages/:id
│   │   ├── numbers.ts           # CRUD /numbers, GET /numbers/resolve
│   │   ├── opt-outs.ts          # GET/POST/DELETE /opt-outs/:phone
│   │   ├── webhooks.ts          # POST /webhooks/twilio/inbound, /status
│   │   └── health.ts            # GET /health
│   ├── services/
│   │   ├── send-message.ts      # outbound flow orchestrator
│   │   ├── template-renderer.ts # inline {{merge_tag}} resolution (pure function)
│   │   ├── number-resolver.ts   # from_number vs location_id+channel lookup
│   │   ├── opt-out-registry.ts  # check, register, remove opt-outs
│   │   ├── rate-limiter.ts      # Redis token bucket per number (evalsha wrapper)
│   │   ├── rate-limiter.lua     # Token bucket Lua script (loaded via SCRIPT LOAD at startup)
│   │   ├── twilio-client.ts     # Twilio SDK wrapper (injectable for testing)
│   │   └── twilio-webhook.ts    # HMAC-SHA1 signature validation (pure function)
│   ├── repositories/
│   │   ├── messages.repo.ts
│   │   ├── numbers.repo.ts
│   │   └── opt-outs.repo.ts
│   ├── events/
│   │   └── publisher.ts         # @ortho/event-bus typed publish helpers
│   └── index.ts
├── migrations/                  # Knex migrations (local to service)
├── seeds/
│   └── dev-numbers.ts           # Test number pool seed data
├── knexfile.ts                  # Local Knex config
├── test/
│   ├── unit/
│   └── integration/
├── Dockerfile
├── package.json
└── tsconfig.json
```

**Runtime dependencies:**
- PostgreSQL (`platform_messaging` schema)
- Redis (rate limiter token buckets)
- `@ortho/event-bus` (EventBridge publishing — uses EventBridge driver in production, Redis Streams driver in local/integration, MockDriver in unit tests)
- Twilio SDK (`twilio` npm package) — production only; in-process stub for dev/test
- `@ortho/logger` (Pino structured JSON logging)
- `@ortho/auth-middleware` (JWT + RBAC on admin routes only)

---

## 15. Observability

- **Structured logging** via `@ortho/logger` (Pino, Datadog-compatible JSON). All request/response cycles, Twilio API calls, rate limit events, opt-out checks, and errors are logged with correlation IDs.
- **Health check** at `GET /health` — returns `200 { "status": "ok" }` for ECS task health probes.
- **Metrics deferred** — Datadog custom metrics (send latency, rate limit hit rate, Twilio error rates) will be added in a later phase. Initial observability is logging + health check only.

---

## 16. Testing Strategy

### Testing Infrastructure

Integration tests requiring Postgres and Redis use the **shared project-level Docker Compose** (`docker-compose.yml` at repo root) that other services also use. No service-local Docker Compose file.

### Twilio Client in Tests

A **lightweight in-process stub** replaces the real Twilio client in all tests. The stub records calls for assertion and returns configurable responses. No HTTP interceptors (`msw`, `nock`) are used.

### Unit Tests (Vitest)

Pure functions — no external dependencies:

- **Template renderer:** merge tag substitution, missing keys render as empty string, nested context objects, pre-rendered body passthrough, edge cases (empty template, no tags)
- **Number resolver:** explicit `from_number` passthrough, `location_id`+`channel` lookup hit and miss, inactive number returns error
- **Rate limiter:** token available → pass, token exhausted → throttle with correct `Retry-After`, token refills after interval, concurrent requests (Lua atomicity)
- **Twilio webhook validator:** valid HMAC-SHA1 signature → pass, tampered payload → reject, missing header → reject
- **STOP detection:** `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT` variants; `UNSTOP`/`START` reversal; case-insensitive; leading/trailing whitespace

### Integration Tests (Vitest + real Postgres + real Redis)

Twilio client replaced by in-process stub:

- Outbound happy path — opt-out check, dedup check, number resolve, render, rate limit, Twilio stub call, DB insert, 200 response
- Dedup — same `dedup_key` twice → second call returns 200 with original `message_id`, Twilio stub called exactly once
- Opted-out number → 400, Twilio stub never called
- Rate limit exceeded → 429 with `Retry-After`, Twilio stub never called
- Number resolve — `location_id`+`channel` resolves correctly; unknown combination → 422
- Twilio API error → message inserted with `status: 'failed'`, 502 returned with Twilio error details
- Status callback delivered → DB status updated, `message.delivered` published (verified via `@ortho/event-bus` MockDriver)
- Status callback failed → DB status + error fields updated, `message.failed` published
- Invalid Twilio signature on webhook → 403, no DB writes, no events published
- Inbound STOP → message inserted first, opt-out inserted, `opt_out.received` published, `inbound_message.received` published
- Inbound UNSTOP (number was opted out) → message inserted first, opt-out removed, `opt_out.removed` published, `inbound_message.received` published
- Inbound UNSTOP (number was not opted out) → message inserted, no `opt_out.removed` published (no-op), `inbound_message.received` published
- Inbound normal message → message inserted, `inbound_message.received` published
- Status callback intermediate (`sent`) → DB status updated, no EventBridge event
- Cursor-based pagination — correct ordering, cursor continuity, boundary conditions

### Contract Tests

**Outbound calls — verify Twilio stub call shape:**
- `messages.create` payload: `to`, `from`, `body`, `mediaUrl`, `statusCallback` URL present and correctly formatted

**Events published — verify against `@ortho/event-bus` schema:**
- `inbound_message.received`, `message.delivered`, `message.failed`, `opt_out.received`, `opt_out.removed` all match declared schema

---

## 17. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Implementation phasing | Three phases: (1) DB + repos + number pool, (2) outbound send flow, (3) webhooks + events | Incremental buildout allows testing each layer independently before adding the next. |
| Twilio SDK testing | In-process stub (no HTTP interceptors) | Simpler than HTTP interception, faster execution, direct call recording for assertions. Stub is injected via constructor so no module patching needed. |
| Rate limiting implementation | Separate Lua file + `SCRIPT LOAD` / `evalsha()` | Lua script is version-controlled, testable independently, and avoids inline string issues. `evalsha()` is more efficient than `eval()` for repeated calls. |
| EventBridge publishing | `@ortho/event-bus` shared package | Typed event helpers, pluggable drivers (EventBridge prod, Redis Streams local, MockDriver tests). Consistent with all other services. See `docs/arch/adr-event-bus.md`. |
| Database migrations | Knex local to service | Each service owns its migrations. No shared migration runner dependency — simpler and consistent with service autonomy principle. |
| Webhook signature validation | Manual HMAC-SHA1 pure function | Avoids Twilio SDK dependency in webhook path. Pure function is easily unit-tested. Registered as Fastify `preHandler` hook. |
| Auth strategy | Auth on admin routes only (`/numbers`, `/opt-outs`); no auth on internal routes (`/messages/send`) | Internal service-to-service calls don't need JWT overhead. Admin endpoints require `@ortho/auth-middleware` for RBAC. |
| Number pool seeding | Seed script (`seeds/dev-numbers.ts`) | Provides consistent dev/test data without requiring manual API calls during setup. |
| Observability | Structured logging (`@ortho/logger`) + health check | Sufficient for initial launch. Datadog custom metrics deferred to avoid premature instrumentation. |
| Twilio API errors | Insert `status: 'failed'` + return `502` with error details | Callers can distinguish Twilio failures from validation errors. Failed message is recorded for audit trail. |
| Pagination | Cursor-based (keyset on `created_at` + `id`) | Better for large datasets with real-time inserts. Consistent page results even as new messages arrive. |
| Webhook error handling | Return `500` on critical failures (DB insert) | Twilio retries the webhook per its retry policy, ensuring no inbound messages are silently dropped. |
| Template rendering | Inline in Messaging Service | SMS templates are short strings with simple `{{merge_tag}}` substitution. Delegating to Template Service adds a synchronous dependency on every send for no benefit at this complexity level. |
| Inbound routing | EventBridge `inbound_message.received` | Platform service must not call product-layer services directly. This service emits `inbound_message.received`; Conversation Service (product layer) subscribes, enriches with lead/conversation context, and emits its own downstream `message.received` event. |
| Opt-out enforcement | Checked on every `POST /messages/send` | Callers do not manage opt-out state. Single enforcement point in the Messaging Service prevents leakage across Automation Engine, Nurturing Engine, and Conversation Service. |
| Dedup | Unique `dedup_key` constraint in DB; duplicate returns 200 with original `message_id` | Handles at-least-once delivery from BullMQ callers safely. Returning 200 (not 409) means callers need no special retry-suppression logic — the response is indistinguishable from a first-time send. |
| Status callbacks | Twilio push → DB update → EventBridge | Polling Twilio for delivery status would be wasteful. Twilio pushes callbacks to the service; the service updates the record and emits events downstream. |
| Voice | Out of scope | Call tracking is a separate concern; excluding it keeps the service focused on SMS/MMS. |
